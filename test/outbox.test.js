// FIX-21: single writer per chat across reconnects (S39), at unit level.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHolder, createQueues, createSender } from "../src/outbox.js";

const quiet = { error: () => {} };
function fakeSock(label, log, { failWith } = {}) {
  return {
    async sendMessage(jid, content, options) {
      if (failWith) throw failWith;
      log.push({ sock: label, jid, text: content.text, options });
      return { key: { id: `${label}-${log.length}` } };
    },
    async sendPresenceUpdate() {},
  };
}

test("S39: a reply finished while disconnected is held, then sent ONCE on the new socket", async () => {
  const log = [];
  const holder = createHolder();
  holder.sock = fakeSock("old", log);
  holder.ready = true;
  const s = createSender(holder, new Map(), quiet, { dropOnFlush: ["One sec"] });
  holder.ready = false; // socket closed mid-turn
  assert.equal(await s.send("a@s", { text: "One sec" }), undefined);
  assert.equal(await s.send("a@s", { text: "The answer." }), undefined);
  holder.sock = fakeSock("new", log);
  holder.ready = true;
  await s.flush();
  assert.deepEqual(log.map((l) => [l.sock, l.text]), [["new", "The answer."]], "one message, filler dropped");
  assert.equal(s.outbox.size, 0);
});

test("S39: a send that fails on a connection error is held, not lost", async () => {
  const log = [];
  const holder = createHolder();
  holder.sock = fakeSock("old", log, { failWith: new Error("Connection Closed") });
  holder.ready = true;
  const s = createSender(holder, new Map(), quiet);
  assert.equal(await s.send("a@s", { text: "The answer." }), undefined);
  holder.sock = fakeSock("new", log);
  await s.flush();
  assert.deepEqual(log.map((l) => l.text), ["The answer."]);
});

test("a non-connection send error still throws (the turn's repair path handles it)", async () => {
  const holder = createHolder();
  holder.sock = fakeSock("s", [], { failWith: new Error("bad content") });
  holder.ready = true;
  await assert.rejects(() => createSender(holder, new Map(), quiet).send("a@s", { text: "x" }), /bad content/);
});

test("S39: per-chat order survives a socket swap (one writer per chat)", async () => {
  const enqueue = createQueues();
  const order = [];
  let release;
  const slow = new Promise((r) => (release = r));
  const first = enqueue("a@s", async () => { await slow; order.push("first answer"); });
  // ...socket reconnects here; the queue is the same object...
  const second = enqueue("a@s", async () => order.push("second message"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [], "the second message waits for the first");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first answer", "second message"]);
});
