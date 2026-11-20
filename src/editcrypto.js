// Decrypt WhatsApp's encrypted message edits (FIX-14b).
//
// Measured live 2026-11-20: an edit from a current WhatsApp client arrives as an upsert with
// `secretEncryptedMessage` (secretEncType MESSAGE_EDIT), not as the protocolMessage that Baileys
// 7.0.0-rc14 (the newest release) turns into `messages.update`. So FIX-14's edit handling never
// fired. VENDORED from upstream WhiskeySockets/Baileys PR #2743 (open, head 705a0e8d,
// src/Utils/decrypt-message-edit.ts), the key derivation and the envelope checks unchanged, cut
// down to 1:1 chats and made synchronous. DELETE THIS FILE when a Baileys release decrypts edits
// itself (then they arrive as messages.update and index.js handles them already).
//
// Construction (from #2743): HKDF-SHA256 single block over the ORIGINAL message's 32-byte
// messageSecret, info = originalMsgId ‖ originalSenderJid ‖ editorJid ‖ "Message Edit" ‖ 0x01;
// AES-256-GCM with a 12-byte IV and empty AAD. The plaintext is a Message holding a MESSAGE_EDIT
// protocolMessage whose key must name the same original message.
//
// The secret is a key, not content, but it decrypts that message's edits: it is kept in memory
// only, per message id, bounded and expired (WhatsApp allows edits for 15 minutes).

import { aesDecryptGCM, hmacSign, isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidNormalizedUser, proto } from "@whiskeysockets/baileys";

const EDIT_ENC = proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT;
const EDIT_PROTOCOL = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;

const isUserJid = (jid) => !!jid && !!(isPnUser(jid) || isLidUser(jid) || isHostedPnUser(jid) || isHostedLidUser(jid));
const uniqueUsers = (jids) => [...new Set(jids.filter(isUserJid).map(jidNormalizedUser))];

export const isEncryptedEdit = (message) => message?.secretEncryptedMessage?.secretEncType === EDIT_ENC;

/** Message secrets of recent inbound messages, by message id (in memory, bounded, expiring). */
export function createSecretStore({ limit = 1000, ttlMs = 20 * 60 * 1000, now = Date.now } = {}) {
  const m = new Map(); // id -> { secret, at }
  return {
    remember(id, secret) {
      if (!id || !(secret instanceof Uint8Array) || secret.byteLength !== 32) return;
      m.delete(id);
      m.set(id, { secret: Buffer.from(secret), at: now() });
      if (m.size > limit) m.delete(m.keys().next().value);
    },
    get(id) {
      const e = m.get(id);
      if (!e) return null;
      if (now() - e.at > ttlMs) {
        m.delete(id);
        return null;
      }
      return e.secret;
    },
  };
}

function decryptOnce({ encPayload, encIv }, { originalMsgId, originalSenderJid, editorJid, messageSecret }) {
  const info = Buffer.concat([
    Buffer.from(originalMsgId),
    Buffer.from(originalSenderJid),
    Buffer.from(editorJid),
    Buffer.from("Message Edit"),
    new Uint8Array([1]),
  ]);
  const extractedKey = hmacSign(messageSecret, new Uint8Array(32), "sha256");
  const decryptionKey = hmacSign(info, extractedKey, "sha256");
  return proto.Message.decode(aesDecryptGCM(Buffer.from(encPayload), decryptionKey, Buffer.from(encIv), new Uint8Array(0)));
}

/**
 * An encrypted edit envelope (an upsert WAMessage) → `{ key, update }` in the shape Baileys emits
 * for a plain MESSAGE_EDIT on messages.update, or null if it cannot be decrypted and checked.
 */
export function decryptEditEnvelope(msg, { secrets, logger = console } = {}) {
  const sem = msg?.message?.secretEncryptedMessage;
  const target = sem?.targetMessageKey;
  if (!isEncryptedEdit(msg?.message) || !target?.id || !sem.encPayload?.length || sem.encIv?.length !== 12) {
    logger.warn?.("[edit] invalid encrypted edit envelope");
    return null;
  }
  // 1:1 chats only (index.js accepts no groups): the original sender and the editor are the same
  // person, who may be addressed by phone number or LID on either message.
  if (msg.key?.fromMe || target.fromMe) return null;
  const messageSecret = secrets?.get(target.id);
  if (!messageSecret) {
    logger.warn?.("[edit] no message secret for the original (restarted, expired, or never seen)");
    return null;
  }
  const k = msg.key ?? {};
  const people = uniqueUsers([target.remoteJid, target.remoteJidAlt, k.remoteJid, k.remoteJidAlt, k.participant, k.participantAlt]);
  let decoded = null;
  for (const originalSenderJid of people) {
    for (const editorJid of people) {
      try {
        decoded = decryptOnce(sem, { originalMsgId: target.id, originalSenderJid, editorJid, messageSecret });
        break;
      } catch {
        /* wrong addressing pair or tampered: try the next */
      }
    }
    if (decoded) break;
  }
  if (!decoded) {
    logger.warn?.("[edit] encrypted edit did not decrypt");
    return null;
  }
  const pm = decoded.protocolMessage;
  if (pm?.type !== EDIT_PROTOCOL || !pm.editedMessage || (pm.key?.id && pm.key.id !== target.id)) {
    logger.warn?.("[edit] decrypted edit is not a MESSAGE_EDIT for this message");
    return null;
  }
  const ts = pm.timestampMs ? Math.floor(Number(pm.timestampMs) / 1000) : msg.messageTimestamp;
  return { key: { ...k, id: target.id }, update: { message: { editedMessage: { message: pm.editedMessage } }, messageTimestamp: ts } };
}
