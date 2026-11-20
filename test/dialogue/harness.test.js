// FIX-01: the offline dialogue harness itself — layers L1 (graph fixtures), L2 (transport,
// outbound budget), L3 (oracle) and the L4 guard. Known defects are `todo` tests that state
// the DESIRED behaviour: red on today's main, green once their fix lands (§7 "red-then-green").
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, scratchPgUri, LIVE_DB_DEFAULT } from "./helpers.js";
import { checkReply } from "./oracle.js";
import { FILLER_TEXT, ERROR_TEXT, CAPTION_PREFACE, repairText } from "../../src/turn.js";

// --- L4 guard -----------------------------------------------------------------------

test("L4: scratchPgUri refuses unset, the live default, and RAGDB_URI", () => {
  assert.throws(() => scratchPgUri({}), /not set/);
  assert.throws(() => scratchPgUri({ IRCC_TEST_PG_URI: LIVE_DB_DEFAULT }), /live checkpoint/);
  assert.throws(() => scratchPgUri({ IRCC_TEST_PG_URI: "postgresql://x/y", RAGDB_URI: "postgresql://x/y" }), /live checkpoint/);
  assert.equal(scratchPgUri({ IRCC_TEST_PG_URI: "postgresql://localhost:5999/scratch" }), "postgresql://localhost:5999/scratch");
});

test("harness: network is forbidden", async () => {
  await assert.rejects(() => fetch("https://example.com"), /network is forbidden/);
});

// --- L3 oracle --------------------------------------------------------------------

test("L3: the oracle flags each formatting and grounding failure seen live", () => {
  const live = "✅ **You cannot sponsor parents right now.**\n# Heading\n| a | b |\n1. step\nhttps://canadaca.ca/x";
  const v = checkReply(live);
  for (const needle of ["double-asterisk", "heading", "table", "bare 'N.'", "outside the allowlist"]) {
    assert.ok(v.some((x) => x.includes(needle)), `expected a ${needle} violation in ${JSON.stringify(v)}`);
  }
  const ok = "✅ *Bold* is single asterisks.\n1) a step\nGeneral info only.\nhttps://www.canada.ca/en/immigration-refugees-citizenship/services/x.html";
  assert.deepEqual(checkReply(ok, { requireDisclaimer: true }), []);
  assert.ok(checkReply(ok, { retrievedUrls: [] }).some((x) => x.includes("not among the retrieved")));
});

// --- L1/L2: today's behaviour, pinned ---------------------------------------------------

test("L2: a fast RAG turn = 1 presence + 1 reply, no filler, no error", async () => {
  const h = makeHarness();
  await h.turn("hi"); // a new chat greets first (today)
  const r = await h.turn("How do I renew my PR card?");
  assert.equal(r.events.filter((e) => e.kind === "presence").length, 1);
  assert.equal(r.sends.length, 1);
  assert.ok(!r.sends.includes(FILLER_TEXT));
  assert.match(r.sends[0], /Answer to: How do I renew my PR card\?/);
  assert.equal(h.calls.retrieve.length, 1);
});

test("L2: a slow turn sends the filler once, then the answer (2 sends)", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    const h = makeHarness({ answer: async (q) => (await gate, `Answer to: ${q}`) });
    await h.turn("hi");
    const pending = h.turn("How do I renew my PR card?");
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(4000);
    await new Promise((r) => setImmediate(r));
    release();
    const r = await pending;
    assert.equal(r.sends.length, 2);
    assert.equal(r.sends[0], FILLER_TEXT);
    assert.match(r.sends[1], /^Answer to: How do I renew my PR card\?/);
  } finally {
    mock.timers.reset();
  }
});

test("L2: a failing turn sends exactly one repair message (FIX-03: no dead end)", async () => {
  const h = makeHarness({ answer: async () => { throw new Error("LLM down"); } });
  await h.turn("hi");
  const r = await h.turn("How do I renew my PR card?");
  assert.deepEqual(r.sends, [repairText("How do I renew my PR card?")]);
  assert.ok(!r.sends.includes(ERROR_TEXT));
  assert.match(r.sends[0], /\*again\*/);
  assert.match(r.sends[0], /canada\.ca/);
  assert.ok(r.error);
});

test("L1: digits at the menu route to the topic prompts without RAG", async () => {
  const h = makeHarness();
  await h.turn("hi");
  const r = await h.turn("1");
  assert.match(r.sends[0], /Visit/);
  assert.equal(h.calls.retrieve.length, 0);
});

// --- Known defects (desired behaviour; red until the named fix lands) --------------------

test("FIX-02: the very first message is answered, not swallowed by the greeting", { todo: "FIX-02" }, async () => {
  const h = makeHarness();
  const r = await h.turn("How do I renew my PR card?");
  assert.equal(h.calls.retrieve.length, 1);
  assert.match(r.sends.at(-1), /Answer to: How do I renew my PR card\?/);
});

test("FIX-09: a bare 'thanks' does not trigger retrieval and the LLM", { todo: "FIX-09" }, async () => {
  const h = makeHarness();
  await h.turn("hi");
  await h.turn("How do I renew my PR card?");
  const before = h.calls.retrieve.length;
  await h.turn("thanks a lot!!!");
  assert.equal(h.calls.retrieve.length, before);
});

async function intoCitizenshipIntake(h) {
  await h.turn("hi");
  await h.turn("2"); // settle long-term
  await h.turn("2"); // citizenship intake: first prompt is "PR status? yes or no"
  await h.turn("yes"); // prStatus stored; now asks for days present
}
const slotsOf = async (h) => (await h.graph.getState({ configurable: { thread_id: h.jid } })).values.slots ?? {};

test("FIX-08: 'about 2 or 3 years' is never stored as 23 days", { todo: "FIX-08" }, async () => {
  const h = makeHarness();
  await intoCitizenshipIntake(h);
  await h.turn("2 or 3 years");
  assert.notEqual((await slotsOf(h)).yearsPresent, 23);
});

test("FIX-08: 'start over' during intake clears the stored answers", { todo: "FIX-08" }, async () => {
  const h = makeHarness();
  await intoCitizenshipIntake(h);
  assert.equal((await slotsOf(h)).prStatus, true, "precondition: an answer is stored");
  await h.turn("start over");
  assert.deepEqual(await slotsOf(h), {});
});

// --- FIX-05: caption preface and disappearing-message timer on every send --------------

test("S10/S09: a captioned turn is prefaced, and every send carries the chat timer", async () => {
  const h = makeHarness();
  await h.turn("hi");
  const opts = { ephemeralExpiration: 86400 };
  const r = await h.turn("what does this biometrics letter mean?", { preface: CAPTION_PREFACE, sendOptions: opts });
  assert.equal(r.sends.length, 1);
  assert.ok(r.sends[0].startsWith(CAPTION_PREFACE + "\n\n"));
  assert.ok(r.events.filter((e) => e.kind === "send").every((e) => e.options === opts));
});

// --- FIX-03: atomic failed turns -------------------------------------------------------

// synthesize fails `n` times (every call while n > 0), then answers.
function failingTimes(n, err = () => new Error("LLM down")) {
  let left = n;
  return async (q) => {
    if (left > 0) { left -= 1; throw err(); }
    return `Answer to: ${q}`;
  };
}

test("S03: after a terminal error the NEXT question is answered (not the old one), and *again* re-asks the saved one", async () => {
  const h = makeHarness({ answer: failingTimes(2) }); // 2 = the first attempt + its one retry
  await h.turn("hi");
  const r1 = await h.turn("What is the fee for a study permit?");
  assert.deepEqual(r1.sends, [repairText("What is the fee for a study permit?")]);
  const r2 = await h.turn("What about a visitor visa?");
  assert.equal(h.calls.retrieve.at(-1).question, "What about a visitor visa?");
  assert.match(r2.sends.at(-1), /^Answer to: What about a visitor visa\?/);
});

test("S03: *again* right after a failure re-runs the saved question", async () => {
  const h = makeHarness({ answer: failingTimes(2) });
  await h.turn("hi");
  await h.turn("What is the fee for a study permit?");
  const r = await h.turn("try again");
  assert.equal(h.calls.retrieve.at(-1).question, "What is the fee for a study permit?");
  assert.match(r.sends.at(-1), /^Answer to: What is the fee for a study permit\?/);
  assert.equal(h.failures.size, 0, "the saved question is cleared after it is answered");
});

test("S04: a transient error is retried silently — a normal answer, no repair text", async () => {
  const h = makeHarness({ answer: failingTimes(1) });
  await h.turn("hi");
  const r = await h.turn("How long is a study permit valid?");
  assert.equal(r.sends.length, 1);
  assert.match(r.sends[0], /^Answer to: How long is a study permit valid\?/);
  assert.equal(h.calls.synthesize.length, 2, "one failed attempt + one retry");
});

test("FIX-03: a deadline (TimeoutError) is not retried", async () => {
  const timeout = () => Object.assign(new Error("Request timed out."), { name: "TimeoutError" });
  const h = makeHarness({ answer: failingTimes(1, timeout) });
  await h.turn("hi");
  const r = await h.turn("How long is a study permit valid?");
  assert.equal(h.calls.synthesize.length, 1, "no retry after the deadline");
  assert.deepEqual(r.sends, [repairText("How long is a study permit valid?")]);
});

test("S05: an error in a mid-intake side question keeps the intake where it was", async () => {
  let failNext = false;
  const h = makeHarness({ answer: async (q) => { if (failNext) throw new Error("LLM down"); return `Answer to: ${q}`; } });
  await h.turn("hi");
  await h.turn("2"); // settle
  await h.turn("1"); // PR intake: age prompt
  failNext = true;
  await h.turn("what counts as skilled work?");
  failNext = false;
  const r = await h.turn("25");
  const st = (await h.graph.getState({ configurable: { thread_id: h.jid } })).values;
  assert.equal(st.slots.age, 25);
  assert.equal(st.slotIndex, 1);
  assert.match(r.sends.at(-1), /education/i);
});

// --- FIX-07: PII minimisation ----------------------------------------------------------

test("FIX-07: turn logs carry a tag and a length, never the message or the reply", async () => {
  const { handleTurn } = await import("../../src/turn.js");
  const h = makeHarness();
  await h.turn("hi");
  const lines = [];
  const logger = { log: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
  const q = "How do I renew my PR card? I am 34";
  await handleTurn({ jid: h.jid, text: q, graph: h.graph, send: async () => {}, presence: async () => {}, logger, failures: new Map() });
  assert.ok(lines.length >= 2);
  for (const l of lines) {
    assert.ok(!l.includes("renew"), `log line leaks the question: ${l}`);
    assert.ok(!l.includes("Answer to"), `log line leaks the reply: ${l}`);
    assert.ok(!l.includes(h.jid.split("@")[0]), `log line leaks the number: ${l}`);
  }
});

test("S13: the intake profile reaches the local model but never the search queries", async () => {
  const h = makeHarness();
  await h.turn("hi");
  await h.turn("2"); // settle
  await h.turn("1"); // PR intake
  for (const a of ["34", "4", "2", "3", "no", "no"]) await h.turn(a);
  const summary = h.calls.synthesize.at(-1).question;
  assert.match(summary, /34/, "the local synthesis input carries the profile");
  for (const { question } of [...h.calls.retrieve, ...h.calls.webFallback.map((q) => ({ question: q }))]) {
    assert.ok(!/\b34\b|\bage\b|My profile/i.test(question), `search query carries the profile: ${question}`);
  }
});
