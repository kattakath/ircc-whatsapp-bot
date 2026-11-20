// FIX-38: content dedupe of resends (S45), never of choices, controls or greetings (S54).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEDUPE_WINDOW_MS, createDedupe, isDedupeCandidate } from "../src/dedupe.js";

test("S54: choices, control words, greetings, prods and closings are never dedupe candidates", () => {
  for (const t of ["2", "1.", "menu", "Menu", "hi", "hello??", "thanks", "ok", "start over", "again", "👍", "yes"]) {
    assert.equal(isDedupeCandidate(t), false, t);
  }
});

test("S45: a free-text question (and a short acronym question) is a candidate", () => {
  assert.equal(isDedupeCandidate("What is the fee for a study permit?"), true);
  assert.equal(isDedupeCandidate("PGWP?"), true);
});

test("S45: in flight → absorbed; answered → found within 10 min; normalisation ignores case and punctuation", () => {
  let t = 0;
  const d = createDedupe({ now: () => t });
  const k1 = d.keyOf("a@s", "What is the fee for a study permit?");
  const k2 = d.keyOf("a@s", "what is the fee for a study permit");
  assert.equal(k1, k2);
  d.start(k1);
  assert.equal(d.status(k2), "inflight");
  d.finish(k1, { key: { id: "BOT1" } });
  t = 3 * 60 * 1000;
  assert.equal(d.answered(k2).sent.key.id, "BOT1");
  t = DEDUPE_WINDOW_MS + 1;
  assert.equal(d.status(k2), null, "expired after the window");
});

test("dedupe is per chat, and a failed turn is forgotten (the next send is a real retry)", () => {
  const d = createDedupe();
  const ka = d.keyOf("a@s", "What is a PGWP?");
  assert.notEqual(ka, d.keyOf("b@s", "What is a PGWP?"));
  d.start(ka);
  d.fail(ka);
  assert.equal(d.status(ka), null);
});
