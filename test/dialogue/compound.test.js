// FIX-34 end to end (S43): retrieval once per part, ONE synthesis with a section per part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./helpers.js";

test("S43: retrieval per part, one combined synthesis, no part dropped", async () => {
  const h = makeHarness();
  await h.turn("hi");
  const r0 = h.calls.retrieve.length;
  await h.turn("how much study permit fee and can my wife work and kids school free?");
  const asked = h.calls.retrieve.slice(r0).map((c) => c.question);
  assert.equal(asked.length, 3);
  assert.match(asked[0], /study permit fee/);
  assert.match(asked[1], /wife work/);
  assert.match(asked[2], /kids school free/);
  assert.equal(h.calls.synthesize.length, 1, "one synthesis call");
  const q = h.calls.synthesize[0].question;
  assert.match(q, /1\) how much study permit fee/);
  assert.match(q, /3\) kids school free/);
});

test("S43: more than three parts — the rest is named at the end", async () => {
  const h = makeHarness();
  await h.turn("hi");
  const r = await h.turn("what is PGWP and SOWP and IEC and LMIA?");
  assert.match(r.sends.at(-1), /You also asked about LMIA — send it next and I'll answer it\./);
});

test("a single question still makes exactly one retrieval", async () => {
  const h = makeHarness();
  await h.turn("hi");
  const r0 = h.calls.retrieve.length;
  await h.turn("Can my wife and kids come with me?");
  assert.equal(h.calls.retrieve.length - r0, 1);
});
