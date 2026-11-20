// Lay wording for lost status ("my status expired", "I overstayed") retrieves IRCC's restoration
// pages, and is high stakes. Measured 2026-11-20: those phrasings ranked only general visitor
// pages (top 0.578-0.661) while "how do I restore my status" ranked the restoration pages first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./helpers.js";
import { expandRetrievalQuery } from "../../src/graph.js";
import { isHighStakes } from "../../src/llm.js";

test("lost-status wording is expanded for retrieval only; the model still gets the user's words", async () => {
  const h = makeHarness();
  await h.turn("hi");
  const q = "My visitor status expired 2 months ago, what can I do";
  await h.turn(q);
  assert.match(h.calls.retrieve.at(-1).question, /restore status restoration 90 days/);
  assert.equal(h.calls.synthesize.at(-1).question, q);
});

test("the expansion fires on lay phrasings of lost status and nowhere else", () => {
  for (const q of ["I overstayed my visitor visa by 2 months what now", "my study permit expired last week", "I am out of status", "we lost our status", "My work permit has expired, can I stay?"])
    assert.match(expandRetrievalQuery(q), /restoration/, q);
  for (const q of ["How long can I stay as a visitor", "When does my passport expire?", "How do I extend my study permit?", "What is the fee for a work permit?"])
    assert.equal(expandRetrievalQuery(q), q, q);
});

test("isHighStakes: lost status in either word order", () => {
  for (const q of ["My visitor status expired 2 months ago", "My visitor status ran out 2 months ago", "I am out of status", "my visa expired", "I lost my status", "I overstayed"])
    assert.equal(isHighStakes(q), true, q);
  for (const q of ["When does my passport expire?", "How long is a visitor visa valid?"]) assert.equal(isHighStakes(q), false, q);
});

test("one pattern: every phrasing that expands retrieval is also high stakes (seen live: 'status ran out')", () => {
  for (const q of ["I overstayed my visitor visa", "my study permit expired last week", "I am out of status", "we lost our status", "My work permit has expired", "My visitor status ran out", "my status has ended"])
    assert.equal(isHighStakes(q), expandRetrievalQuery(q) !== q, q);
});
