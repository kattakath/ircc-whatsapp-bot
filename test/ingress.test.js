// FIX-40 regression tests: the ingress gate (src/ingress.js). Scenarios S49 and S52
// in test/fixtures/conversation-scenarios.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { admit, classifyInbound, jidTag } from "../src/ingress.js";

const noSleep = async () => {};

test("classifyInbound: typed text, captionless media, and everything else", () => {
  assert.deepEqual(classifyInbound({ conversation: "What is a study permit?" }), { kind: "text", text: "What is a study permit?" });
  assert.deepEqual(classifyInbound({ extendedTextMessage: { text: "hi there" } }), { kind: "text", text: "hi there" });
  for (const m of ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"]) {
    assert.deepEqual(classifyInbound({ [m]: {} }), { kind: "media" }, m);
  }
  assert.deepEqual(classifyInbound({ reactionMessage: { text: "👍" } }), { kind: "other" });
  assert.deepEqual(classifyInbound({ conversation: "   " }), { kind: "other" });
  assert.deepEqual(classifyInbound(null), { kind: "other" });
});

test("S52: a non-allowlisted sender is refused (no outbound may follow)", async () => {
  const gate = await admit(async () => "denied", "15550000000@s.whatsapp.net", { sleep: noSleep });
  assert.deepEqual(gate, { admit: false, reason: "not-allowlisted" });
});

test("S52: a throwing allowlist check is a refusal, never a reply", async () => {
  const gate = await admit(async () => { throw new Error("lid store down"); }, "x@lid", { sleep: noSleep });
  assert.equal(gate.admit, false);
  assert.equal(gate.reason, "check-failed");
  assert.match(gate.error.message, /lid store down/);
});

test("S49: an unresolved @lid is retried once, then admitted when it resolves", async () => {
  const calls = [];
  const answers = ["unresolved", "allowed"];
  const gate = await admit(async (jid) => { calls.push(jid); return answers.shift(); }, "abc@lid", { sleep: noSleep });
  assert.deepEqual(gate, { admit: true, reason: "allowed" });
  assert.equal(calls.length, 2);
});

test("S49: an @lid that never resolves is refused as lid-unresolved (the operator-alert path)", async () => {
  let n = 0;
  const gate = await admit(async () => { n += 1; return "unresolved"; }, "abc@lid", { sleep: noSleep });
  assert.deepEqual(gate, { admit: false, reason: "lid-unresolved" });
  assert.equal(n, 2, "exactly one retry");
});

test("an allowlisted sender is admitted on the first check", async () => {
  let n = 0;
  const gate = await admit(async () => { n += 1; return "allowed"; }, "1@s.whatsapp.net", { sleep: noSleep });
  assert.deepEqual(gate, { admit: true, reason: "allowed" });
  assert.equal(n, 1);
});

test("jidTag is stable and never contains the phone number", () => {
  const jid = "15145551234@s.whatsapp.net";
  assert.equal(jidTag(jid), jidTag(jid));
  assert.match(jidTag(jid), /^[0-9a-f]{10}$/);
  assert.ok(!jidTag(jid).includes("5145551234"));
});
