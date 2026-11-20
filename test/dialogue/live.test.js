// FIX-20 end to end: live answers bypass RAG; a missing country is asked once and bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./helpers.js";

test("a processing-time question with a country is answered from the live feed, no search", async () => {
  const h = makeHarness();
  await h.turn("hi");
  const r = await h.turn("How long is the study permit processing time from India?");
  assert.match(r.sends.at(-1), /Study permit, applying from India:\* about \*7 weeks\*/);
  assert.match(r.sends.at(-1), /updated November 18, 2026/);
  assert.equal(h.calls.synthesize.length, 0);
  assert.equal(h.calls.retrieve.length, 0);
});

test("no country: one question, and the reply binds to it", async () => {
  const h = makeHarness();
  await h.turn("hi");
  const q = await h.turn("what is the processing time for a work permit?");
  assert.match(q.sends.at(-1), /Which country are you applying from\?/);
  const a = await h.turn("Nigeria");
  assert.match(a.sends.at(-1), /Work permit, applying from Nigeria:\* about \*10 weeks\*/);
  assert.equal(h.calls.synthesize.length, 0);
});

test("the latest Express Entry draws, on a new chat with the identity line", async () => {
  const h = makeHarness();
  const r = await h.turn("latest express entry draw?");
  assert.match(r.sends.at(-1), /not IRCC/);
  assert.match(r.sends.at(-1), /#453 · October 28, 2026/);
});

test("a feed that fails abstains with the official link, and does not fall back to RAG", async () => {
  const h = makeHarness({ liveFetch: async () => { throw new Error("ECONNRESET"); } });
  await h.turn("hi");
  const r = await h.turn("study permit processing time from India");
  assert.match(r.sends.at(-1), /couldn't load IRCC's live processing times/);
  assert.equal(h.calls.synthesize.length, 0);
});
