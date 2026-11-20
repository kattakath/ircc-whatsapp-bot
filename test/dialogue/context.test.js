// FIX-16 (C13): bounded context (last 2 questions) + a GATED question-in-context rewrite + the
// interpretation shown as a 📌 heading. S30, S32, S41. Rewrite latency measured on gpt-oss:20b:
// median 3.0 s, max 3.5 s (5 follow-ups, 2026-11-20), so it runs only when the gate says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./helpers.js";
import { needsRewrite } from "../../src/graph.js";

const REWRITES = {
  "no I meant study permit": "What is the fee for a study permit?",
  "and for my wife?": "What is the fee for a study permit for a spouse?",
  "no thats wrong, I asked for my mother not me": "What is the fee for a parent to visit Canada?",
};
const rewrite = (q) => REWRITES[q] ?? q;

test("S30: 'no I meant study permit' is rewritten in context; the reply opens with the 📌 interpretation", async () => {
  const h = makeHarness({ rewrite });
  await h.turn("hi");
  await h.turn("What is the fee for a work permit?");
  const r = await h.turn("no I meant study permit");
  assert.equal(h.calls.rewrite.at(-1).previous.at(-1), "What is the fee for a work permit?");
  assert.match(h.calls.retrieve.at(-1).question, /fee for a study permit/);
  assert.match(r.sends.at(-1), /^📌 \*What is the fee for a study permit\?\*/);
  const w = await h.turn("and for my wife?");
  assert.equal(h.calls.rewrite.at(-1).previous.at(-1), "What is the fee for a study permit?", "the window holds the rewritten question");
  assert.match(h.calls.retrieve.at(-1).question, /spouse/);
  assert.match(w.sends.at(-1), /^📌/);
});

test("S41: a complaint with content is rewritten for the mother, apology first", async () => {
  const h = makeHarness({ rewrite });
  await h.turn("hi");
  await h.turn("What is the fee for a work permit?");
  const r = await h.turn("no thats wrong, I asked for my mother not me");
  assert.match(r.sends.at(-1), /^Sorry about that — 📌 \*What is the fee for a parent to visit Canada\?\*/);
});

test("S32: after 'start over' a follow-up has no old context — no rewrite", async () => {
  const h = makeHarness({ rewrite });
  await h.turn("hi");
  await h.turn("What is the fee for a work permit?");
  await h.turn("start over");
  const before = h.calls.rewrite.length;
  await h.turn("what about for my wife?");
  assert.equal(h.calls.rewrite.length, before);
  assert.doesNotMatch(h.calls.retrieve.at(-1).question, /work permit/);
});

test("the gate: standalone questions and first questions are not rewritten", async () => {
  const h = makeHarness({ rewrite });
  await h.turn("hi");
  await h.turn("What is the fee for a work permit?"); // no context yet
  await h.turn("How long does Express Entry take for a skilled worker in Ontario?");
  assert.equal(h.calls.rewrite.length, 0);
});

test("a failed rewrite falls back to the user's own words, without a heading", async () => {
  const h = makeHarness({ rewrite: () => { throw new Error("timeout"); } });
  await h.turn("hi");
  await h.turn("What is the fee for a work permit?");
  const r = await h.turn("no I meant study permit");
  assert.equal(h.calls.retrieve.at(-1).question, "no I meant study permit");
  assert.doesNotMatch(r.sends.at(-1), /📌 \*/);
});

test("needsRewrite (C13): short, repair marker, or a pronoun with no programme", () => {
  const ctx = [{ q: "What is a PGWP?", at: Date.now() }];
  for (const t of ["no I meant study permit", "and for my wife?", "how long does it take?", "what about PNP?", "how many hours?", "actually the fee"])
    assert.equal(needsRewrite(t, ctx), true, t);
  for (const t of ["How long does Express Entry take for a skilled worker in Ontario?", "Can I work while studying on a study permit?"])
    assert.equal(needsRewrite(t, ctx), false, t);
  assert.equal(needsRewrite("and for my wife?", []), false, "no context, no rewrite");
  assert.equal(needsRewrite("and for my wife?", [{ q: "x", at: Date.now() - 5 * 3600 * 1000 }]), false, "context older than 4 h");
});

test("the rewrite prompt anchors the follow-up to the LATEST question (live: two equal-weight questions were merged)", async () => {
  const { rewriteMessages } = await import("../../src/llm.js");
  const [sys, user] = rewriteMessages("and for my wife?", ["What is the fee for a work permit?", "What is the fee for a study permit?"]);
  assert.match(sys.content, /continues the LATEST question/);
  assert.match(sys.content, /never expand them/);
  assert.match(user.content, /Earlier question \(background only\): What is the fee for a work permit\?/);
  assert.match(user.content, /Latest question: What is the fee for a study permit\?\nFollow-up: and for my wife\?/);
  const [, one] = rewriteMessages("how many hours?", ["Can I work while studying?"]);
  assert.doesNotMatch(one.content, /Earlier question/);
});
