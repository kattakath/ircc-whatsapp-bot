#!/usr/bin/env node
import "dotenv/config";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { Command } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { builder } from "./graph.js";
import { admit, classifyInbound, jidTag } from "./ingress.js";

// One checkpointer/compiled graph shared across the whole process — on the
// local Postgres at RAGDB_URI (retrieval itself is Cloudflare AI Search, see
// src/aisearch.js; only checkpoints live here). setup() creates the
// checkpoint tables if they don't exist yet (idempotent, safe to call once).
const checkpointer = PostgresSaver.fromConnString(
  process.env.RAGDB_URI ?? "postgresql://mcp@127.0.0.1:5433/ragdb"
);
await checkpointer.setup();
const graph = builder.compile({ checkpointer });

// Optional allowlist: comma-separated phone numbers (digits only, no "+"),
// e.g. ALLOWED_NUMBERS="15145551234,16045557890". If unset, replies to
// anyone who messages this number — fine for a private prototype, but set
// this once real people (beyond your friend) might have the number.
const ALLOWED_NUMBERS = (process.env.ALLOWED_NUMBERS ?? "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);

// Set this to the SPARE number (digits only, no "+") to pair via
// "Link with phone number" instead of scanning a QR code — WhatsApp gives
// you an 8-char code to type in, which sidesteps the QR's tight expiry
// window entirely.
const PAIR_PHONE_NUMBER = (process.env.PAIR_PHONE_NUMBER ?? "").trim();

// WhatsApp sometimes delivers a sender as a "@lid" (linked ID) instead of a
// plain phone-number JID — a newer privacy identifier that doesn't map
// directly to a phone number. Resolve it via Baileys' LID<->PN store before
// checking the allowlist.
// Returns "allowed", "denied" or "unresolved" (an @lid with no PN mapping yet);
// src/ingress.js admit() retries "unresolved" once and turns a throw into a refusal.
async function allowState(sock, jid) {
  if (ALLOWED_NUMBERS.length === 0) return "allowed";

  let checkJid = jid;
  if (jid.endsWith("@lid")) {
    const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
    if (!pn) return "unresolved";
    checkJid = pn;
  }

  const number = checkJid.split("@")[0].split(":")[0];
  return ALLOWED_NUMBERS.includes(number) ? "allowed" : "denied";
}

// Guards against reconnect storms: never auto-retry unbounded, and never
// re-request a pairing code more than once per process lifetime (a prior
// bug here caused dozens of pairing-code requests against WhatsApp's
// servers within seconds — exactly what anti-abuse detection watches for).
const MAX_RECONNECT_ATTEMPTS = 3;
let reconnectAttempts = 0;
let pairingCodeRequested = false;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    // Baileys default: first QR lives 60s, every regenerated one only 20s —
    // too tight for scan -> read confirmation dialog -> tap Continue on a
    // human timescale. Give every QR a full 2 minutes.
    qrTimeout: 120_000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Request the pairing code on the first `qr` event, never earlier: that
    // event is the proof the login handshake finished. Sending it as soon as
    // the WebSocket opened made WhatsApp drop the socket (428) about 2s later,
    // before anyone could type the code (measured 2026-11-19, twice).
    if (qr && PAIR_PHONE_NUMBER && !state.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true;
      const code = await sock.requestPairingCode(PAIR_PHONE_NUMBER);
      console.log(
        `\nOn the SPARE number: WhatsApp > Linked Devices > Link a Device > Link with phone number instead\n` +
          `Enter this code: ${code}\n`
      );
      return;
    }

    if (qr && !PAIR_PHONE_NUMBER) {
      console.log("\nScan this QR code from the SPARE number: WhatsApp > Linked Devices > Link a Device\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      reconnectAttempts = 0;
      console.log("WhatsApp connected. Listening for messages...");
      return;
    }

    if (connection !== "close") return;

    const statusCode = lastDisconnect?.error?.output?.statusCode;

    if (statusCode === DisconnectReason.loggedOut) {
      console.log("Logged out. Delete the auth/ directory and restart to re-pair.");
      return;
    }

    if (PAIR_PHONE_NUMBER && !state.creds.registered) {
      // A pairing code is outstanding. Reconnect (bounded, below) so a live
      // socket is there when the code is typed in; the module-level
      // `pairingCodeRequested` flag stops the reconnect from asking for a new
      // code, which is what caused the old runaway loop.
      console.log(
        `Connection closed (code ${statusCode}: ${lastDisconnect?.error?.message ?? "no reason"}) ` +
          `before pairing completed. The code shown above stays valid.`
      );
    }

    reconnectAttempts += 1;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error(`Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts (code ${statusCode}). Restart manually.`);
      return;
    }
    const delayMs = Math.min(30_000, 2 ** reconnectAttempts * 2000);
    console.log(
      `Connection closed (code ${statusCode}). Reconnecting in ${delayMs / 1000}s ` +
        `(attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
    );
    setTimeout(start, delayMs);
  });

  // Only ever called for a sender admit() already let through (see messages.upsert).
  async function processMessage(jid, text) {
    console.log(`[in]  ${jid}: ${text}`);

    let answered = false;
    let presenceInterval = null;
    let fillerTimer = null;

    try {
      await sock.sendPresenceUpdate("composing", jid);

      // A deep-reasoning synthesis model can take 30-60s. This is
      // deliberately NOT inside a graph node (a node re-executes from its
      // top on resume-after-crash, so any side effect before its interrupt()
      // would double-fire) — instead plain timers here handle it, decoupled
      // from which internal node happens to be slow.

      // WhatsApp's "composing" indicator isn't persistent — it has a short
      // TTL (~10-25s) and silently disappears if not refreshed. A single
      // send at the start looks like it stopped typing well before a
      // 30-90s reply actually arrives. Keep refreshing it periodically.
      presenceInterval = setInterval(() => {
        if (answered) return; // belt-and-suspenders alongside clearInterval in finally
        sock.sendPresenceUpdate("composing", jid).catch((err) => {
          console.error("Failed to refresh composing presence:", err);
        });
      }, 8000);

      fillerTimer = setTimeout(async () => {
        if (answered) return; // avoid a filler landing just after the real reply
        try {
          await sock.sendMessage(jid, { text: "One sec — checking the official IRCC info... 🍁" });
        } catch (err) {
          console.error("Failed to send slow-reply filler:", err);
        }
      }, 4000);

      const config = { configurable: { thread_id: jid } };
      const snapshot = await graph.getState(config);
      const isFreshThread = snapshot.next.length === 0;
      // A conversation abandoned mid-intake for a week+ (she dropped off,
      // came back later expecting a clean slate) resuming stale slot
      // answers from memory would be confusing, not helpful — treat it as
      // a fresh start instead. createdAt is the last checkpoint's
      // timestamp, so this only fires on genuinely old, untouched threads.
      const STALE_MS = 7 * 24 * 60 * 60 * 1000;
      const isStale = snapshot.createdAt && Date.now() - new Date(snapshot.createdAt).getTime() > STALE_MS;
      const input =
        isFreshThread || isStale ? { incomingText: text } : new Command({ resume: text });
      const result = await graph.invoke(input, config);

      const reply = result.__interrupt__?.[0]?.value;
      if (!reply) {
        // Shouldn't happen — the graph always loops back to a node that
        // interrupts — but don't leave the user hanging if it ever does.
        throw new Error(`Graph returned no interrupt to reply with: ${JSON.stringify(result)}`);
      }

      console.log(`[out] ${jid}: ${reply.slice(0, 120)}${reply.length > 120 ? "..." : ""}`);
      await sock.sendMessage(jid, { text: reply });
    } catch (err) {
      // The allowlist check no longer runs here (it is admit() at ingress), so
      // this only ever answers an admitted sender whose turn failed.
      console.error("Error handling message:", err);
      try {
        await sock.sendMessage(jid, {
          text: "Sorry, something went wrong on my end — try again in a moment.",
        });
      } catch (sendErr) {
        console.error("Also failed to send the error reply:", sendErr);
      }
    } finally {
      // Always clean up, whether we succeeded, errored, or returned early
      // (e.g. not-allowlisted) — an uncleared interval here would otherwise
      // ping presence updates for this jid forever.
      answered = true;
      if (fillerTimer) clearTimeout(fillerTimer);
      if (presenceInterval) clearInterval(presenceInterval);
    }
  }

  // Serialize processing per sender: without this, a burst of messages sent
  // while a slow reply is still in flight fire concurrently and get
  // answered out of order, which reads as broken to a non-technical user.
  // Different senders still run fully in parallel.
  const jidQueues = new Map();
  function enqueue(jid, task) {
    const prev = jidQueues.get(jid) ?? Promise.resolve();
    const next = prev.then(task, task);
    jidQueues.set(jid, next.catch(() => {}));
    return next;
  }

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue;

      // Reactions, protocol messages and the like never earn a reply (a 👍
      // answered would be noise), so they need no allowlist lookup either.
      const inbound = classifyInbound(msg.message);
      if (inbound.kind === "other") continue;

      enqueue(jid, async () => {
        // Allowlist FIRST (FIX-40): nothing below may send, set presence or log
        // message text for a sender who is not admitted.
        const gate = await admit((j) => allowState(sock, j), jid);
        if (!gate.admit) {
          if (gate.reason === "not-allowlisted") {
            console.log(`[ignored] non-allowlisted sender #${jidTag(jid)}`);
          } else {
            // check-failed or lid-unresolved: possibly an allowlisted relative
            // being dropped, so this is the operator's alert line. No text.
            console.error(`[alert] ingress ${gate.reason} for #${jidTag(jid)}${gate.error ? `: ${gate.error.message}` : ""}`);
          }
          return;
        }

        if (inbound.kind === "media") {
          // Silence would look exactly like a broken bot: nudge an admitted
          // sender who sent a photo/voice note/document with no caption.
          try {
            await sock.sendMessage(jid, {
              text: "I can only read text messages right now — could you type your question instead?",
            });
          } catch (err) {
            console.error("Failed to send media-nudge reply:", err);
          }
          return;
        }

        await processMessage(jid, inbound.text);
      });
    }
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
