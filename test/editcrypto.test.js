// FIX-14b: decrypt WhatsApp's encrypted message edits (secretEncryptedMessage, MESSAGE_EDIT).
// Fixtures are built with plain node:crypto, independent of the code under test and of Baileys'
// helpers; no real identifiers, secrets or content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { proto } from "@whiskeysockets/baileys";
import { createSecretStore, decryptEditEnvelope, isEncryptedEdit } from "../src/editcrypto.js";

const USER = "15550000001@s.whatsapp.net";
const USER_LID = "123456789012345@lid";
const ORIG_ID = "3EB0ORIGINAL0001";

function encryptEdit({ secret, originalSenderJid, editorJid, originalId = ORIG_ID, newText = "Can my wife study in Canada?", iv = randomBytes(12), keyId = originalId }) {
  const plaintext = proto.Message.encode({
    protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id: keyId }, editedMessage: { conversation: newText }, timestampMs: 1_800_000_000_000 },
  }).finish();
  const info = Buffer.concat([Buffer.from(originalId), Buffer.from(originalSenderJid), Buffer.from(editorJid), Buffer.from("Message Edit"), Buffer.from([1])]);
  const prk = createHmac("sha256", Buffer.alloc(32)).update(secret).digest();
  const key = createHmac("sha256", prk).update(info).digest();
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.alloc(0));
  const encPayload = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT, targetMessageKey: { id: originalId, remoteJid: USER, fromMe: true /* sender-relative: the editor wrote the original (live 2026-11-20) */ }, encPayload, encIv: iv };
}

const envelope = (sem, key = { remoteJid: USER, fromMe: false, id: "3EB0EDITENVELOPE" }) => ({ key, message: { messageContextInfo: {}, secretEncryptedMessage: sem }, messageTimestamp: 1_800_000_000 });

test("an encrypted edit decrypts to a messages.update on the ORIGINAL message's key", () => {
  const secret = randomBytes(32);
  const secrets = createSecretStore();
  secrets.remember(ORIG_ID, secret);
  const msg = envelope(encryptEdit({ secret, originalSenderJid: USER, editorJid: USER }));
  assert.equal(isEncryptedEdit(msg.message), true);
  const out = decryptEditEnvelope(msg, { secrets });
  assert.equal(out.key.id, ORIG_ID);
  assert.equal(out.key.remoteJid, USER);
  assert.equal(out.update.message.editedMessage.message.conversation, "Can my wife study in Canada?");
});

test("PN/LID: the sender may have used either address; both are tried", () => {
  const secret = randomBytes(32);
  const secrets = createSecretStore();
  secrets.remember(ORIG_ID, secret);
  const sem = encryptEdit({ secret, originalSenderJid: USER_LID, editorJid: USER_LID });
  const out = decryptEditEnvelope(envelope(sem, { remoteJid: USER, remoteJidAlt: USER_LID, fromMe: false, id: "E2" }), { secrets });
  assert.equal(out?.update.message.editedMessage.message.conversation, "Can my wife study in Canada?");
});

test("refused: tampered payload, wrong secret, unknown original, bad IV, mismatched inner target", () => {
  const secret = randomBytes(32);
  const secrets = createSecretStore();
  secrets.remember(ORIG_ID, secret);
  const quiet = { warn: () => {} };
  const good = encryptEdit({ secret, originalSenderJid: USER, editorJid: USER });
  const tampered = { ...good, encPayload: Buffer.from(good.encPayload).fill(7, 0, 1) };
  assert.equal(decryptEditEnvelope(envelope(tampered), { secrets, logger: quiet }), null, "tampered");
  const other = createSecretStore();
  other.remember(ORIG_ID, randomBytes(32));
  assert.equal(decryptEditEnvelope(envelope(good), { secrets: other, logger: quiet }), null, "wrong secret");
  assert.equal(decryptEditEnvelope(envelope(good), { secrets: createSecretStore(), logger: quiet }), null, "no stored secret");
  assert.equal(decryptEditEnvelope(envelope({ ...good, encIv: randomBytes(8) }), { secrets, logger: quiet }), null, "IV length");
  const wrongTarget = encryptEdit({ secret, originalSenderJid: USER, editorJid: USER, keyId: "SOMEOTHERID" });
  assert.equal(decryptEditEnvelope(envelope(wrongTarget), { secrets, logger: quiet }), null, "inner key mismatch");
});

test("the secret store keeps 32-byte secrets only, is bounded, and expires them", () => {
  let t = 0;
  const s = createSecretStore({ limit: 2, ttlMs: 1000, now: () => t });
  s.remember("a", randomBytes(16));
  assert.equal(s.get("a"), null, "wrong length is not kept");
  s.remember("a", randomBytes(32));
  s.remember("b", randomBytes(32));
  s.remember("c", randomBytes(32));
  assert.equal(s.get("a"), null, "evicted");
  assert.ok(s.get("c"));
  t = 2000;
  assert.equal(s.get("c"), null, "expired");
});
