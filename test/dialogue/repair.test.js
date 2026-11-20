// FIX-15a: repair vocabulary (C8) — control words, cancel at intake, escalating no-match,
// continue after a side question, start over clears context. S27, S28, S29, S32.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./helpers.js";
import { parseControl } from "../../src/control.js";

const stateOf = async (h) => (await h.graph.getState({ configurable: { thread_id: h.jid } })).values;
async function intoPrIntake(h) {
  await h.turn("hi");
  await h.turn("2"); // settle
  await h.turn("1"); // PR intake: age prompt
}

test("C8: normalise, then match the whole message; anchored phrases keep the rest; cancel only at intake", () => {
  for (const t of ["menu", "Menu?", "menu please", "show main menu", "MENU 🙏", "reset", "restart", "start over", "Start again!", "never mind", "nevermind", "forget that", "new question", "go back to the menu", "can you restart please"])
    assert.deepEqual(parseControl(t), { verb: "reset", rest: null }, t);
  for (const t of ["reset my GCKey password", "cancel my biometrics appointment how?", "how do I restart my application?", "what is the new question on the form", "cancel"])
    assert.equal(parseControl(t), null, t);
  assert.deepEqual(parseControl("can we start over please, I want to ask about my mom visiting"), { verb: "reset", rest: "I want to ask about my mom visiting" });
  assert.deepEqual(parseControl("never mind. How long is a visitor visa valid?"), { verb: "reset", rest: "How long is a visitor visa valid?" });
  assert.deepEqual(parseControl("cancel", { atIntake: true }), { verb: "cancel", rest: null });
  assert.equal(parseControl("cancel my visa application", { atIntake: true }), null);
});

test("S27: reset words inside a real question reach RAG; 'menu please' and 'Menu?' show the menu", async () => {
  const h = makeHarness();
  await h.turn("hi");
  for (const q of ["reset my GCKey password", "cancel my biometrics appointment how?"]) {
    const before = h.calls.synthesize.length;
    const r = await h.turn(q);
    assert.equal(h.calls.synthesize.length, before + 1, `${q} reached RAG`);
    assert.match(r.sends.at(-1), /Answer to:/, q);
  }
  for (const q of ["menu please", "Menu?"]) {
    const r = await h.turn(q);
    assert.match(r.sends.at(-1), /1\) Visit/, q);
    assert.doesNotMatch(r.sends.at(-1), /Answer to:/, q);
  }
});

test("S27: 'cancel' at an intake prompt stops the check and clears it", async () => {
  const h = makeHarness();
  await intoPrIntake(h);
  await h.turn("29");
  const r = await h.turn("cancel");
  assert.match(r.sends.at(-1), /^Okay, stopping the PR check\./);
  const st = await stateOf(h);
  assert.deepEqual(st.slots, {});
  assert.equal(st.branch, null);
});

test("S27: 'can we start over please, …' resets, then answers the rest", async () => {
  const h = makeHarness();
  await intoPrIntake(h);
  const r = await h.turn("can we start over please, I want to ask about my mom visiting");
  assert.equal(h.calls.synthesize.at(-1).question, "I want to ask about my mom visiting");
  assert.match(r.sends.at(-1), /Answer to: I want to ask about my mom visiting/);
  assert.deepEqual((await stateOf(h)).slots, {});
});

test("S28: a repeated no-match escalates: restate, then a hint, then the way out", async () => {
  const h = makeHarness();
  await intoPrIntake(h);
  const r1 = await h.turn("blue");
  assert.match(r1.sends.at(-1), /How old are you\?/);
  const r2 = await h.turn("blue");
  assert.match(r2.sends.at(-1), /Just the number, like 34\./);
  const r3 = await h.turn("blue");
  assert.match(r3.sends.at(-1), /\bmenu\b/i);
  assert.match(r3.sends.at(-1), /stop/i);
  assert.equal(h.calls.synthesize.length, 0, "no RAG for a no-match");
  const r4 = await h.turn("34");
  assert.match(r4.sends.at(-1), /highest level of education/, "a valid answer still moves on");
});

test("S29: a side question mid-intake is answered, then 'continue or stop?'; continue resumes", async () => {
  const h = makeHarness();
  await intoPrIntake(h);
  await h.turn("25");
  const r = await h.turn("How do I sponsor my mother?");
  assert.match(r.sends.at(-1), /Answer to: How do I sponsor my mother\?/);
  assert.match(r.sends.at(-1), /Continue the PR check \(1 of 6 done\), or stop\?/);
  assert.doesNotMatch(r.sends.at(-1), /highest level of education/, "the slot prompt waits for 'continue'");
  const c = await h.turn("continue");
  assert.match(c.sends.at(-1), /highest level of education/);
  assert.equal((await stateOf(h)).slots.age, 25);
});

test("S29: 'stop' after a side question ends the check", async () => {
  const h = makeHarness();
  await intoPrIntake(h);
  await h.turn("25");
  await h.turn("How do I sponsor my mother?");
  const r = await h.turn("stop");
  assert.match(r.sends.at(-1), /^Okay, stopping the PR check\./);
  assert.deepEqual((await stateOf(h)).slots, {});
});

test("S32: 'start over' clears the last answer's sources", async () => {
  const h = makeHarness();
  await h.turn("hi");
  await h.turn("What is the fee for a work permit?");
  assert.ok((await stateOf(h)).lastSources.length > 0, "precondition: an answer left sources");
  const r = await h.turn("start over");
  assert.match(r.sends.at(-1), /1\) Visit/);
  assert.deepEqual((await stateOf(h)).lastSources, []);
});

test("advisor: a reset's remainder goes through the same gate — 'never mind, thanks' never reaches RAG", async () => {
  for (const msg of ["never mind, thanks", "forget it, bye"]) {
    const h = makeHarness();
    await h.turn("hi");
    await h.turn("What is the fee for a work permit?");
    const before = h.calls.synthesize.length;
    await h.turn(msg);
    assert.equal(h.calls.synthesize.length, before, msg);
  }
});

test("S29: a bare 'no' to 'continue or stop?' asks again instead of wiping the intake", async () => {
  const h = makeHarness();
  await intoPrIntake(h);
  await h.turn("25");
  await h.turn("How do I sponsor my mother?");
  const r = await h.turn("no");
  assert.match(r.sends.at(-1), /\*stop\*/);
  assert.match(r.sends.at(-1), /\*continue\*/);
  assert.equal((await stateOf(h)).slots.age, 25, "the stored answer is kept");
  const c = await h.turn("continue");
  assert.match(c.sends.at(-1), /highest level of education/);
});
