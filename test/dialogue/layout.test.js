// FIX-18 end to end: S35 (budget, tolerant 'more', tapered reminder), S36 (code-rendered disclaimer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./helpers.js";
import { DISCLAIMER, MORE_LINE } from "../../src/layout.js";

const LONG = `✅ Yes, you can work while studying.\n\n${Array.from({ length: 24 }, (_, i) => `• Point ${i + 1}: ${"detail ".repeat(12)}`).join("\n")}`;
const HINT = /Want to explore a specific path\?/;

test("S35: a long answer is capped with 'Reply more'; the hint tapers; 'pls continue' sends the remainder; 'more about X' is a question", async () => {
  const h = makeHarness({ answer: (q) => (/work while studying/i.test(q) ? LONG : `Answer to: ${q}`) });
  await h.turn("hi");
  const r1 = await h.turn("Can I work while studying?");
  const a1 = r1.sends.at(-1);
  assert.ok(a1.includes(MORE_LINE), "ends with Reply more");
  assert.match(a1, HINT, "first answer of the session carries the hint");
  assert.ok((a1.match(/🔗/g) ?? []).length <= 2);
  assert.ok(!a1.includes("Point 24"), "the overflow is not sent");

  const r2 = await h.turn("How many hours a week?");
  assert.doesNotMatch(r2.sends.at(-1), HINT, "no hint on the second answer");

  const before = h.calls.synthesize.length;
  const firstMissing = Array.from({ length: 24 }, (_, i) => i + 1).find((n) => !a1.includes(`Point ${n}:`));
  const r3 = await h.turn("pls continue");
  assert.ok(r3.sends.at(-1).includes(`Point ${firstMissing}:`), "the remainder starts where the first message stopped");
  assert.ok(r3.sends.at(-1).includes(MORE_LINE), "a long remainder is chunked too");
  let last = r3;
  for (let i = 0; i < 5 && last.sends.at(-1).includes(MORE_LINE); i++) last = await h.turn("more");
  assert.match(last.sends.at(-1), /Point 24/);
  assert.ok(!last.sends.at(-1).includes(MORE_LINE));
  assert.equal(h.calls.synthesize.length, before, "no new synthesis");

  await h.turn("more about PGWP");
  assert.equal(h.calls.synthesize.at(-1).question, "more about PGWP");
});

test("S35: 'more' with nothing stored says so, without a search", async () => {
  const h = makeHarness();
  await h.turn("hi");
  const r = await h.turn("more");
  assert.match(r.sends.at(-1), /That's everything I had/);
  assert.equal(h.calls.synthesize.length, 0);
});

test("S36: full disclaimer once, then the short footer; a high-stakes question gets the strong block from code", async () => {
  const h = makeHarness();
  await h.turn("hi");
  const a = (await h.turn("How do I get a study permit?")).sends.at(-1);
  assert.ok(a.includes(DISCLAIMER.full));
  const b = (await h.turn("What documents do I need?")).sends.at(-1);
  assert.ok(b.includes(DISCLAIMER.short) && !b.includes(DISCLAIMER.full));
  const c = (await h.turn("I overstayed my visa, what now?")).sends.at(-1);
  assert.ok(c.includes(DISCLAIMER.strong));
});
