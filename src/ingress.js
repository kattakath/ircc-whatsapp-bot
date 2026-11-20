// Ingress gate (docs/conversation-design.md FIX-40, principle P0 "allowlist first").
//
// Every inbound message that could earn ANY outbound event (a reply, the media
// nudge, a presence update) passes `admit()` first, in the per-chat queue, before
// anything is sent or logged with its text. Before this, the media-nudge branch
// replied to any stranger who sent a photo, voice note or sticker, and a throwing
// allowlist check answered "Sorry, something went wrong" to whoever sent it.
//
// Pure functions only: index.js wires them to Baileys, the tests drive them
// directly (test/ingress.test.js).
import { createHash } from "node:crypto";

/**
 * Classify one Baileys message for routing, before any allowlist lookup:
 *   { kind: "text", text }  a typed message (conversation or extendedTextMessage)
 *   { kind: "media" }       media with no caption (image/video/audio/document/sticker)
 *   { kind: "other" }       reactions, protocol messages, anything else: no outbound
 */
export function classifyInbound(message) {
  if (!message) return { kind: "other" };
  const text = message.conversation ?? message.extendedTextMessage?.text ?? "";
  if (text.trim()) return { kind: "text", text };
  const isMedia = !!(
    message.imageMessage ||
    message.videoMessage ||
    message.audioMessage ||
    message.documentMessage ||
    message.stickerMessage
  );
  return { kind: isMedia ? "media" : "other" };
}

/**
 * Decide whether a sender is admitted. `check(jid)` returns "allowed", "denied"
 * or "unresolved" (an @lid not yet mapped to a phone number), and may throw.
 * An unresolved @lid gets ONE retry after `retryDelayMs`: the LID→PN mapping
 * often lands a moment after the first message (scenario S49).
 * Never throws: a failed check is a refusal with reason "check-failed".
 */
export async function admit(check, jid, { retryDelayMs = 1500, sleep = defaultSleep } = {}) {
  try {
    let verdict = await check(jid);
    if (verdict === "unresolved") {
      await sleep(retryDelayMs);
      verdict = await check(jid);
    }
    if (verdict === "allowed") return { admit: true, reason: "allowed" };
    return { admit: false, reason: verdict === "unresolved" ? "lid-unresolved" : "not-allowlisted" };
  } catch (error) {
    return { admit: false, reason: "check-failed", error };
  }
}

/** A short, stable, non-reversible tag for a jid, so logs never carry a phone number. */
export function jidTag(jid) {
  return createHash("sha256").update(String(jid)).digest("hex").slice(0, 10);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
