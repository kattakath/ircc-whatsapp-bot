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

test("S01 (FIX-02): the very first message is answered in ONE reply, with the identity line", async () => {
  const h = makeHarness();
  const r = await h.turn("How do I renew my PR card?");
  assert.equal(h.calls.retrieve.length, 1);
  assert.equal(r.sends.length, 1);
  assert.match(r.sends[0], /^👋🏽 I'm Izzy's Minion 🤓, a helper bot \(not IRCC, not a person\)/);
  assert.match(r.sends[0], /Answer to: How do I renew my PR card\?/);
  const r2 = await h.turn("And for a child?");
  assert.ok(!r2.sends[0].includes("helper bot"), "the intro appears once per chat");
});

test("S02 (FIX-02): a greeting gets the identity line and the menu, no RAG, no 'official IRCC website'", async () => {
  const h = makeHarness();
  const r = await h.turn("hi");
  assert.equal(h.calls.retrieve.length, 0);
  assert.match(r.sends[0], /not IRCC, not a person/);
  assert.match(r.sends[0], /1\) Visit/);
  assert.ok(!/official IRCC website/.test(r.sends[0]));
});

test("FIX-09: a bare 'thanks' does not trigger retrieval and the LLM", async () => {
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

test("S14 (FIX-08): an estimate or a range is never stored as a day count; it gets the calculator", async () => {
  for (const estimate of ["2 or 3 years", "about 3 years", "around 1000", "1000-1100 days", "not sure"]) {
    const h = makeHarness();
    await intoCitizenshipIntake(h);
    const r = await h.turn(estimate);
    assert.equal((await slotsOf(h)).yearsPresent, undefined, `"${estimate}" was stored`);
    assert.match(r.sends.at(-1), /physical-presence\.html/, `"${estimate}" did not get the calculator`);
  }
});

test("S14 (FIX-08): an exact day count is stored as written", async () => {
  for (const [exact, n] of [["1100", 1100], ["1,100 days", 1100], ["1095", 1095]]) {
    const h = makeHarness();
    await intoCitizenshipIntake(h);
    await h.turn(exact);
    assert.equal((await slotsOf(h)).yearsPresent, n, exact);
  }
});

test("S15/S40 (FIX-08): ok, 👍, haan and nahi answer a yes/no prompt", async () => {
  for (const [reply, want] of [["ok", "yes"], ["👍", "yes"], ["haan", "yes"], ["Yes please!", "yes"], ["nahi", "no"], ["👎", "no"]]) {
    const h = makeHarness();
    await h.turn("hi");
    await h.turn("2");
    await h.turn("2"); // "PR status? yes or no"
    await h.turn(reply);
    assert.equal((await slotsOf(h)).prStatus, want, reply);
  }
});

test("FIX-08: 'start over' during intake clears the stored answers", async () => {
  const h = makeHarness();
  await intoCitizenshipIntake(h);
  assert.equal((await slotsOf(h)).prStatus, "yes", "precondition: an answer is stored");
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

// --- FIX-09: pre-router dialogue-act gate ----------------------------------------------

import { REPLIES } from "../../src/gate.js";

async function afterAnswer() {
  const h = makeHarness();
  await h.turn("hi");
  await h.turn("What is a PGWP?");
  return h;
}

test("S17: closings, acks and noise after an answer are instant and never reach RAG", async () => {
  const h = await afterAnswer();
  const before = h.calls.retrieve.length;
  assert.deepEqual((await h.turn("thanks 🙏")).sends, [REPLIES.closing]);
  assert.deepEqual((await h.turn("👍")).sends, [], "an ack earns silence");
  assert.deepEqual((await h.turn("asdfgh")).sends, [REPLIES.noise]);
  assert.equal(h.calls.retrieve.length, before);
});

test("S17: a short acronym question still reaches RAG", async () => {
  const h = await afterAnswer();
  const before = h.calls.retrieve.length;
  await h.turn("PGWP?");
  assert.equal(h.calls.retrieve.length, before + 1);
});

test("S44: identity, handoff and file questions get fixed replies with official links, no RAG", async () => {
  const h = makeHarness();
  await h.turn("hi");
  assert.deepEqual((await h.turn("are you IRCC?")).sends, [REPLIES.identity]);
  assert.deepEqual((await h.turn("can I talk to someone? please call me")).sends, [REPLIES.handoff]);
  assert.deepEqual((await h.turn("can you check my file")).sends, [REPLIES.fileCheck]);
  assert.equal(h.calls.retrieve.length, 0);
  assert.match(REPLIES.identity, /not IRCC and not a person/);
  assert.match(REPLIES.handoff, /canada\.ca\/.+contact-ircc/);
});

test("S16: '1.', 'one' and '2!' at the menu are choices, not questions", async () => {
  for (const [reply, want] of [["1.", /Visit/], ["one", /Visit/], ["2!", /Settle permanently/]]) {
    const h = makeHarness();
    await h.turn("hi");
    const r = await h.turn(reply);
    assert.match(r.sends[0], want, reply);
    assert.equal(h.calls.retrieve.length, 0, reply);
  }
});

test("FIX-09 guard: real questions that LOOK like small talk still reach RAG", async () => {
  for (const q of [
    "Thanks, but how do I apply for a study permit?",
    "sorry, what is the fee for a PR card?",
    "Are you sure the biometrics fee is $85?",
    "can you check my eligibility for express entry?",
    "ok and what about my wife's open work permit?",
    "wait, do I need a medical exam for a visitor visa?",
    "no I meant the citizenship test, how many questions?",
  ]) {
    const h = makeHarness();
    await h.turn("hi");
    await h.turn(q);
    assert.equal(h.calls.retrieve.length, 1, `"${q}" was swallowed by the gate`);
  }
});

// --- FIX-10: carry the message; quote only when adjacency breaks --------------------------

test("FIX-10: an adjacent reply is not quoted (today's look)", async () => {
  const h = makeHarness();
  await h.turn("hi");
  const msg = { key: { id: "IN1" }, message: { conversation: "What is a PGWP?" } };
  const r = await h.turn("What is a PGWP?", { message: msg, newerInbound: () => false });
  const reply = r.events.filter((e) => e.kind === "send").at(-1);
  assert.equal(reply.options?.quoted, undefined);
});

test("FIX-10: a reply overtaken by a newer user message quotes the question it answers", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    const h = makeHarness({ answer: async (q) => (await gate, `Answer to: ${q}`) });
    await h.turn("hi");
    const msg = { key: { id: "IN1" }, message: { conversation: "What is a PGWP?" } };
    let newer = false;
    const pending = h.turn("What is a PGWP?", { message: msg, newerInbound: () => newer });
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(4000); // the filler goes out while the answer is still generating
    await new Promise((r) => setImmediate(r));
    newer = true; // the user sends another message before the answer is ready
    release();
    const r = await pending;
    const sends = r.events.filter((e) => e.kind === "send");
    assert.equal(sends[0].text, FILLER_TEXT);
    assert.equal(sends[0].options?.quoted, undefined, "the filler is never quoted");
    assert.equal(sends.at(-1).options?.quoted, msg, "the answer quotes its question");
  } finally {
    mock.timers.reset();
  }
});

test("FIX-10: each sent prompt's id and time are recorded for choice binding (C15)", async () => {
  const prompts = new Map();
  const h = makeHarness();
  await h.turn("hi", { prompts, now: () => 1234 });
  const p = prompts.get(h.jid);
  assert.match(p.id, /^BOT\d+$/);
  assert.equal(p.sentAt, 1234);
});

// --- FIX-22: negative-feedback repair -----------------------------------------------------

import { SOURCES_NONE } from "../../src/gate.js";
const STUB_URL = "https://www.canada.ca/en/immigration-refugees-citizenship/services/stub.html";

test("S18: a bare complaint gets options (another way, the source, a licensed rep), no RAG; 'show me the page' gives the source", async () => {
  const h = makeHarness();
  await h.turn("hi");
  await h.turn("What is the fee for a work permit?");
  const before = h.calls.retrieve.length;
  const r1 = await h.turn("that is wrong");
  assert.deepEqual(r1.sends, [REPLIES.complaint]);
  assert.match(REPLIES.complaint, /\*source\*/);
  assert.match(REPLIES.complaint, /licensed consultant or lawyer/);
  const r2 = await h.turn("show me the page");
  assert.match(r2.sends[0], new RegExp(STUB_URL.replace(/[.?]/g, "\\$&")));
  assert.equal(h.calls.retrieve.length, before, "no RAG for the complaint or the source request");
});

test("S41: a complaint WITH content is answered (apology first); a bare 'wrong' gets the options", async () => {
  const h = makeHarness();
  await h.turn("hi");
  await h.turn("What is the fee for a work permit?");
  const r = await h.turn("no thats wrong, I asked for my mother not me");
  assert.equal(h.calls.retrieve.at(-1).question, "no thats wrong, I asked for my mother not me");
  assert.match(r.sends[0], /^Sorry about that — Answer to:/);
  assert.deepEqual((await h.turn("wrong")).sends, [REPLIES.complaint]);
});

test("FIX-22: asking for the source before any answer says so instead of searching", async () => {
  const h = makeHarness();
  await h.turn("hi");
  assert.deepEqual((await h.turn("source")).sends, [SOURCES_NONE]);
  assert.equal(h.calls.retrieve.length, 0);
});
