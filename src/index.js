#!/usr/bin/env node
import "dotenv/config";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { builder, pendingPromptText } from "./graph.js";
import { mediaReply } from "./media.js";
import { ANSWERED_ABOVE, createDedupe, isDedupeCandidate } from "./dedupe.js";
import { FORWARDED_PREFACE, FRAUD_CHECK, forwardedAction } from "./gate.js";
import { admit, classifyInbound, jidTag } from "./ingress.js";
import { CAPTION_PREFACE, FILLER_TEXT, handleTurn } from "./turn.js";
import { createHolder, createQueues, createSender } from "./outbox.js";
import { OFFLINE_NOTE, OFFLINE_PREFACE, acceptInbound, createSeen, planBacklog } from "./offline.js";
import { findSensitive, sensitiveReply } from "./redact.js";

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
// FIX-21: one writer per chat for the whole process. The socket is swapped on reconnect; the
// queues, the newest-inbound map and the outbox are not.
const holder = createHolder();
const enqueue = createQueues();
const sender = createSender(holder, new Map(), console, { dropOnFlush: [FILLER_TEXT] });
const latestInbound = new Map(); // FIX-10: newest inbound id per chat
const mediaStreak = new Map(); // FIX-23: consecutive captionless media per chat, for tapering
const dedupe = createDedupe(); // FIX-38: resends of the same free-text question
const seen = createSeen(); // FIX-13: message ids already handled ("append" and "notify" can repeat one)

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

  holder.sock = sock;
  holder.ready = false;

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
      holder.ready = true;
      console.log("WhatsApp connected. Listening for messages...");
      await sender.flush(); // answers finished while disconnected: one message per chat
      return;
    }

    if (connection !== "close") return;
    holder.ready = false;

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
      // Exit so the supervisor (launchd KeepAlive / systemd Restart=always) starts a fresh process;
      // returning left a live process with no socket, which no supervisor ever restarts.
      console.error(`Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts (code ${statusCode}). Exiting for a restart.`);
      process.exit(1);
    }
    const delayMs = Math.min(30_000, 2 ** reconnectAttempts * 2000);
    console.log(
      `Connection closed (code ${statusCode}). Reconnecting in ${delayMs / 1000}s ` +
        `(attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
    );
    setTimeout(start, delayMs);
  });

  // Only ever called for a sender admit() already let through (see messages.upsert).
  // The turn itself lives in src/turn.js so the offline harness can drive it.
  function processMessage(jid, inbound, sendOptions, msg, { offline = false, forwarded = false } = {}) {
    const preface = [offline ? OFFLINE_PREFACE : null, forwarded ? FORWARDED_PREFACE : null, inbound.captioned ? CAPTION_PREFACE : null].filter(Boolean).join("\n");
    return handleTurn({
      jid,
      message: msg,
      // A late answer always quotes the message it answers (S23).
      newerInbound: () => offline || latestInbound.get(jid) !== msg?.key?.id,
      text: inbound.text,
      preface: preface || null,
      sendOptions,
      graph,
      send: sender.send,
      presence: sender.presence,
    });
  }

  // Messages are serialised per sender (a burst answered concurrently reads as broken); senders
  // run in parallel. The queues live at module scope (FIX-21: createQueues) to survive reconnects.

  // Everything an inbound message may trigger, for live and offline messages alike. Runs inside
  // the per-chat queue; the allowlist gate (FIX-40) comes first on BOTH paths.
  async function handleInbound(msg, inbound, { offline = false } = {}) {
    const jid = msg.key.remoteJid;
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

    // Reply inside the same disappearing-message timer the user chose (FIX-05).
    const sendOptions = inbound.ephemeralExpiration ? { ephemeralExpiration: inbound.ephemeralExpiration } : undefined;

    // FIX-07: an ID number (UCI, SIN, application, passport) is never processed: no graph
    // run, no checkpoint, no search query, no log of the text. One instant, canned reply (S12).
    const sensitive = inbound.kind === "text" ? findSensitive(inbound.text) : [];
    if (sensitive.length) {
      console.log(`[redacted] #${jidTag(jid)} sent ${sensitive.join(", ")}; not processed`);
      try {
        await sender.send(jid, { text: sensitiveReply(sensitive) }, sendOptions);
      } catch (err) {
        console.error("Failed to send the ID-number reply:", err);
      }
      return;
    }

    if (inbound.kind === "media") {
      // FIX-23: a line per media kind, restating a pending intake question; a sticker gets none.
      const repeat = (mediaStreak.get(jid) ?? 0) > 0;
      mediaStreak.set(jid, (mediaStreak.get(jid) ?? 0) + 1);
      let pendingPrompt = null;
      try {
        pendingPrompt = pendingPromptText((await graph.getState({ configurable: { thread_id: jid } })).values);
      } catch {
        /* no state yet: no question to restate */
      }
      const text = mediaReply({ mediaType: inbound.mediaType, pendingPrompt, repeat });
      if (!text) return;
      try {
        await sender.send(jid, { text }, sendOptions);
      } catch (err) {
        console.error("Failed to send media-nudge reply:", err);
      }
      return;
    }
    mediaStreak.delete(jid);

    // FIX-39: a forwarded scam gets IRCC's fraud guidance, never a restatement or a search.
    const fwd = forwardedAction(inbound);
    if (fwd === "fraud") {
      console.log(`[fraud-check] #${jidTag(jid)} forwarded scam-like text; not processed`);
      await sender.send(jid, { text: FRAUD_CHECK }, { ...sendOptions, quoted: msg });
      return;
    }

    // FIX-38: the same free-text question again within 10 min, already answered → one line
    // quoting that answer instead of a second RAG turn. Never mid-intake (that is a slot answer).
    let midIntake = false;
    try {
      midIntake = !!pendingPromptText((await graph.getState({ configurable: { thread_id: jid } })).values);
    } catch {
      /* no state yet */
    }
    const dedupeKey = !midIntake && isDedupeCandidate(inbound.text) ? dedupe.keyOf(jid, inbound.text) : null;
    const earlier = dedupeKey && dedupe.answered(dedupeKey);
    if (earlier?.status === "answered") {
      console.log(`[dedupe] #${jidTag(jid)} resent an answered question`);
      await sender.send(jid, { text: ANSWERED_ABOVE }, earlier.sent ? { ...sendOptions, quoted: earlier.sent } : sendOptions);
      return;
    }
    if (dedupeKey) dedupe.start(dedupeKey);
    const result = await processMessage(jid, inbound, sendOptions, msg, { offline, forwarded: fwd === "forwarded" });
    if (dedupeKey) (result?.reply ? dedupe.finish(dedupeKey, result.sent) : dedupe.fail(dedupeKey));
  }

  // FIX-13: one note for an offline backlog older than the window, quoting its newest message.
  async function sendOfflineNote(msg) {
    const jid = msg.key.remoteJid;
    const gate = await admit((j) => allowState(sock, j), jid);
    if (!gate.admit) return;
    await sender.send(jid, { text: OFFLINE_NOTE }, { quoted: msg });
  }

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;

    const fresh = [];
    for (const msg of messages) {
      if (!acceptInbound(msg) || seen.has(msg.key.id)) continue;
      seen.add(msg.key.id);
      // Reactions, protocol messages and the like never earn a reply (a 👍 answered would be noise).
      const inbound = classifyInbound(msg.message);
      if (inbound.kind === "other") continue;
      fresh.push({ msg, inbound });
    }

    if (type === "notify") {
      for (const { msg, inbound } of fresh) {
        const jid = msg.key.remoteJid;
        // FIX-38: a resend while the same question is still being answered is absorbed silently.
        if (inbound.kind === "text" && isDedupeCandidate(inbound.text) && dedupe.status(dedupe.keyOf(jid, inbound.text)) === "inflight") {
          console.log(`[dedupe] #${jidTag(jid)} resend absorbed while in flight`);
          continue;
        }
        latestInbound.set(jid, msg.key.id);
        enqueue(jid, () => handleInbound(msg, inbound));
      }
      return;
    }

    // "append": the offline backlog, grouped per chat (S23).
    const byChat = new Map();
    for (const item of fresh) {
      const jid = item.msg.key.remoteJid;
      byChat.set(jid, [...(byChat.get(jid) ?? []), item]);
    }
    for (const [jid, items] of byChat) {
      const { answer, noteFor } = planBacklog(items.map((i) => i.msg));
      if (noteFor) enqueue(jid, () => sendOfflineNote(noteFor).catch((err) => console.error("Failed to send the offline note:", err)));
      for (const { msg, inbound } of items.filter((i) => answer.includes(i.msg))) {
        latestInbound.set(jid, msg.key.id);
        enqueue(jid, () => handleInbound(msg, inbound, { offline: true }));
      }
    }
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
