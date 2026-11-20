// FIX-15b: out-of-order slot correction (S20, S26) and a recap before synthesis (S26, S13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./helpers.js";

const stateOf = async (h) => (await h.graph.getState({ configurable: { thread_id: h.jid } })).values;
async function intoPrIntake(h) {
  await h.turn("hi");
  await h.turn("2"); // settle
  await h.turn("1"); // PR intake: age prompt
}

test("S20: 'sorry 30' re-binds the last answered slot, then asks the current question again", async () => {
  const h = makeHarness();
  await intoPrIntake(h);
  await h.turn("29");
  const r = await h.turn("sorry 30");
  assert.match(r.sends.at(-1), /Updated: age 30\./);
  assert.match(r.sends.at(-1), /highest level of education/);
  assert.equal((await stateOf(h)).slots.age, 30);
  assert.equal(h.calls.synthesize.length, 0);
});

test("S26: a correction, then a numbered recap that waits for OK; an item number changes one answer", async () => {
  const h = makeHarness();
  await intoPrIntake(h);
  await h.turn("32");
  const c = await h.turn("wait I am actually 34 not 32");
  assert.match(c.sends.at(-1), /Updated: age 34\./);
  assert.match(c.sends.at(-1), /highest level of education/);
  assert.equal(h.calls.synthesize.length, 0, "a correction is not a side question");

  let r;
  for (const a of ["4", "2", "3", "no", "no"]) r = await h.turn(a);
  const recap = r.sends.at(-1);
  assert.match(recap, /1\) Age: 34/);
  assert.match(recap, /2\) Education: Bachelor's degree/);
  assert.match(recap, /Reply \*OK\*, or the item number to change it/);
  assert.equal(h.calls.synthesize.length, 0, "no synthesis before OK");

  const q = await h.turn("1");
  assert.match(q.sends.at(-1), /What should your age be\?/);
  const again = await h.turn("35");
  assert.match(again.sends.at(-1), /1\) Age: 35/);
  assert.match(again.sends.at(-1), /2\) Education: Bachelor's degree/, "only age changed");
  assert.equal(h.calls.synthesize.length, 0);

  await h.turn("OK");
  assert.equal(h.calls.synthesize.length, 1);
  assert.match(h.calls.synthesize.at(-1).question, /age 35/);
});

test("recap: an unclear reply restates it; 'menu' resets", async () => {
  const h = makeHarness();
  await intoPrIntake(h);
  for (const a of ["34", "4", "2", "3", "no", "no"]) await h.turn(a);
  const r = await h.turn("hmm");
  assert.match(r.sends.at(-1), /Reply \*OK\*, or the item number to change it/);
  assert.equal(h.calls.synthesize.length, 0);
  const m = await h.turn("menu");
  assert.match(m.sends.at(-1), /1\) Visit/);
  assert.deepEqual((await stateOf(h)).slots, {});
});
