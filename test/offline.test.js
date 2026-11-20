// FIX-13: messages that arrived while the bot was offline (S23).
import { test } from "node:test";
import assert from "node:assert/strict";
import { OFFLINE_WINDOW_MS, acceptInbound, createSeen, planBacklog } from "../src/offline.js";

const msg = (over = {}) => ({ key: { remoteJid: "15550000001@s.whatsapp.net", id: "A1", fromMe: false }, message: { conversation: "hi" }, messageTimestamp: 1000, ...over });

test("S23: only a real person's 1:1 message is accepted from the backlog", () => {
  assert.equal(acceptInbound(msg()), true);
  assert.equal(acceptInbound(msg({ key: { remoteJid: "abc@lid", id: "L1", fromMe: false } })), true);
  for (const [why, m] of [
    ["own send", msg({ key: { remoteJid: "15550000001@s.whatsapp.net", id: "A2", fromMe: true } })],
    ["group", msg({ key: { remoteJid: "123@g.us", id: "G1", fromMe: false } })],
    ["newsletter", msg({ key: { remoteJid: "123@newsletter", id: "N1", fromMe: false } })],
    ["status broadcast", msg({ key: { remoteJid: "status@broadcast", id: "S1", fromMe: false } })],
    ["offline call / no content", msg({ message: null })],
  ]) assert.equal(acceptInbound(m), false, why);
});

test("S23: inside the window → answered; beyond it → ONE note quoting the newest old message", () => {
  const now = 10_000_000_000;
  const at = (minsAgo, id) => msg({ key: { remoteJid: "x@s.whatsapp.net", id, fromMe: false }, messageTimestamp: (now - minsAgo * 60_000) / 1000 });
  const recent = at(5, "R1");
  const old1 = at(120, "O1");
  const old2 = at(119, "O2");
  const plan = planBacklog([old1, old2, recent], now);
  assert.deepEqual(plan.answer.map((m) => m.key.id), ["R1"]);
  assert.equal(plan.noteFor.key.id, "O2");
  assert.equal(planBacklog([recent], now).noteFor, null, "no note when nothing is old");
  assert.equal(OFFLINE_WINDOW_MS, 30 * 60 * 1000);
});

test("S23: the same message id is handled once, even if re-emitted as notify", () => {
  const seen = createSeen(3);
  assert.equal(seen.has("A1"), false);
  seen.add("A1");
  assert.equal(seen.has("A1"), true);
  for (const id of ["B", "C", "D"]) seen.add(id);
  assert.equal(seen.has("A1"), false, "bounded: the oldest id is evicted");
});
