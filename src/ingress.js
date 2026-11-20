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
import { normalizeMessageContent } from "@whiskeysockets/baileys";

const MEDIA_TYPES = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];

/**
 * Classify one Baileys message for routing, before any allowlist lookup (FIX-05: inbound
 * normalizer). Wrappers are unwrapped first with Baileys' own normalizeMessageContent
 * (ephemeral / disappearing-mode, view-once, document-with-caption): before this, a question
 * sent in a disappearing chat was silently dropped.
 *
 *   { kind: "text",  text, captioned, forwarded, ephemeralExpiration }
 *       typed text, or the CAPTION of a photo/video/document (captioned: true)
 *   { kind: "media", forwarded, ephemeralExpiration }   media with no caption
 *   { kind: "other" }   reactions, protocol messages (incl. edits/revokes), anything else
 *
 * Edits arrive as protocolMessage and are skipped here on purpose: an edit must not be
 * answered as a brand-new question (messages.update is the only edit path).
 * `forwarded` is exposed for the forwarded-scam handling (FIX-39); nothing acts on it yet.
 * `ephemeralExpiration` is the chat's disappearing timer, so replies can match it.
 */
export function classifyInbound(message, { normalize = normalizeMessageContent } = {}) {
  if (!message || message.protocolMessage || message.editedMessage) return { kind: "other" };
  const content = normalize(message);
  if (!content || content.protocolMessage) return { kind: "other" };

  // A plain `conversation` string carries no contextInfo; text-with-context and media do.
  const ctx = content.extendedTextMessage?.contextInfo ?? MEDIA_TYPES.map((k) => content[k]?.contextInfo).find(Boolean);
  const meta = {
    forwarded: !!ctx?.isForwarded,
    ...(ctx?.expiration ? { ephemeralExpiration: ctx.expiration } : {}),
  };

  const typed = content.conversation ?? content.extendedTextMessage?.text ?? "";
  if (typed.trim()) return { kind: "text", text: typed, captioned: false, ...meta };

  const caption = content.imageMessage?.caption ?? content.videoMessage?.caption ?? content.documentMessage?.caption ?? "";
  if (caption.trim()) return { kind: "text", text: caption, captioned: true, ...meta };

  const mediaKey = MEDIA_TYPES.find((k) => content[k]);
  if (mediaKey) return { kind: "media", mediaType: mediaKey.replace("Message", ""), ...meta }; // image|video|audio|document|sticker
  return { kind: "other" };
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
