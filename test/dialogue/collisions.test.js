// FIX-01: gate-collision baseline. Runs every corpus reply at the menu prompt and counts how
// many reach retrieval + the LLM (a ~27 s turn on the local model). This is TODAY's false-
// positive count under the `length > 12` rule; FIX-09's pre-router gate must lower it
// without misrouting real questions (the advisor's weakest assumption, open question 21).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeHarness } from "./helpers.js";

const corpus = JSON.parse(fs.readFileSync(new URL("../fixtures/gate-collisions.json", import.meta.url), "utf8"));

test("collision baseline: non-questions at the menu that reach RAG today", async () => {
  const hits = [];
  for (const reply of corpus.atMenu) {
    const h = makeHarness();
    await h.turn("hi"); // greeting → menu prompt
    await h.turn(reply);
    if (h.calls.retrieve.length > 0) hits.push(reply);
  }
  console.log(`[collisions] ${hits.length}/${corpus.atMenu.length} non-questions reached RAG: ${JSON.stringify(hits)}`);
  assert.ok(hits.length <= corpus.atMenu.length);
});

test("FIX-09: no corpus non-question reaches RAG", { todo: "FIX-09" }, async () => {
  for (const reply of corpus.atMenu) {
    const h = makeHarness();
    await h.turn("hi");
    await h.turn(reply);
    assert.equal(h.calls.retrieve.length, 0, `"${reply}" reached RAG`);
  }
});
