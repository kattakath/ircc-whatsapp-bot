// FIX-19 (clarifying branch only; abstention waits for open question 9): S37, S47.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./helpers.js";

test("S37: a bare ambiguous topic gets ONE clarifying question, no search; the reply binds to it", async () => {
  const h = makeHarness();
  await h.turn("hi");
  const r = await h.turn("permit?");
  assert.match(r.sends.at(-1), /Which permit do you mean — study, work or visitor\?/);
  assert.equal(h.calls.synthesize.length, 0);
  await h.turn("study");
  assert.match(h.calls.synthesize.at(-1).question, /study permit/i);
});

test("S37: the clarification binds only the very next message; anything else is answered as itself", async () => {
  const h = makeHarness();
  await h.turn("hi");
  await h.turn("visa?");
  await h.turn("How long does Express Entry take?");
  assert.equal(h.calls.synthesize.at(-1).question, "How long does Express Entry take?");
  await h.turn("study");
  assert.notEqual(h.calls.synthesize.at(-1)?.question ?? "", "How do I get a study permit?", "no stale binding");
});

test("S47: a delay story with no question gets the intro plus ONE clarifying question; 'what to do' answers that", async () => {
  const h = makeHarness();
  const r = await h.turn("Hello sir, my son applied study permit july, biometrics done, still nothing, agent not replying");
  const reply = r.sends.at(-1);
  assert.match(reply, /not IRCC/, "the identity line on a first message");
  assert.match(reply, /processing times/);
  assert.match(reply, /taking too long/);
  assert.equal(h.calls.synthesize.length, 0);
  await h.turn("what to do");
  assert.match(h.calls.synthesize.at(-1).question, /study permit/i);
  assert.match(h.calls.synthesize.at(-1).question, /longer than (the )?normal|taking too long/i);
});

test("not a clarification: real questions and stories without a delay go to RAG as before", async () => {
  const h = makeHarness();
  await h.turn("hi");
  for (const q of ["My study permit application is still processing, what does that mean?", "I applied for my study permit in July and got biometrics done", "Which permit do I need to work on campus?"]) {
    const before = h.calls.synthesize.length;
    await h.turn(q);
    assert.equal(h.calls.synthesize.length, before + 1, q);
  }
});

test("S37: with no official content the reply is honest — a rephrase tip, no promise to fetch a page", async () => {
  const { synthesize } = await import("../../src/llm.js");
  const text = await synthesize("How much does a Canadian passport renewal cost?", []);
  assert.doesNotMatch(text, /fetch/i);
  assert.match(text, /another way|program name/i);
});
