// FIX-20: live IRCC data (processing times, Express Entry draws) from IRCC's JSON feeds, with a
// schema check and an abstain path. Fixtures mirror the feeds' MEASURED shape (2026-11-20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLiveData, liveIntent, PTIME_TOOL_URL, EE_ROUNDS_URL } from "../src/livedata.js";

const fx = (f) => readFileSync(new URL(`./fixtures/ircc-json/${f}`, import.meta.url), "utf8");
const FEEDS = { ptime: fx("data-ptime-en.json"), countries: fx("data-country-name-en.json"), rounds: fx("ee_rounds_123_en.json") };
const fakeFetch = (overrides = {}) => async (url) => {
  const key = /ptime/.test(url) ? "ptime" : /country/.test(url) ? "countries" : "rounds";
  const body = overrides[key] ?? FEEDS[key];
  if (body instanceof Error) throw body;
  return { ok: true, status: 200, text: async () => body };
};

test("liveIntent: processing time by category and country; draws; everything else is not live", () => {
  assert.deepEqual(liveIntent("How long is the study permit processing time from India?"), { kind: "ptime", category: "study", country: "India" });
  assert.deepEqual(liveIntent("processing time for visitor visa in nigeria"), { kind: "ptime", category: "visitor-outside-canada", country: "Nigeria" });
  assert.deepEqual(liveIntent("how long does a work permit take"), { kind: "ptime", category: "work", country: null });
  assert.deepEqual(liveIntent("latest express entry draw"), { kind: "draws" });
  assert.deepEqual(liveIntent("What was the CRS cutoff in the last round?"), { kind: "draws" });
  for (const q of ["How long does Express Entry take?", "How long is a visitor visa valid?", "What is the fee for a study permit?", "How long can I stay as a visitor?",
    // a delay ("what can I do?") is not a request for the estimate (FIX-19's follow-up)
    "My study permit application is taking longer than the normal processing time. What can I do?"])
    assert.equal(liveIntent(q), null, q);
});

test("a processing time is answered from the feed with IRCC's 'as of' date and the official tool", async () => {
  const live = createLiveData({ fetch: fakeFetch() });
  const r = await live.answer({ kind: "ptime", category: "study", country: "India" });
  assert.match(r, /Study permit.*India.*7 weeks/s);
  assert.match(r, /November 18, 2026/);
  assert.ok(r.includes(PTIME_TOOL_URL));
});

test("no estimate for that country: says so plainly, with the tool link — never a guess", async () => {
  const live = createLiveData({ fetch: fakeFetch() });
  const r = await live.answer({ kind: "ptime", category: "study", country: "Andorra" });
  assert.match(r, /no current estimate/i);
  assert.ok(r.includes(PTIME_TOOL_URL));
});

test("the latest draws, newest first, with the draw date", async () => {
  const live = createLiveData({ fetch: fakeFetch() });
  const r = await live.answer({ kind: "draws" });
  assert.match(r, /#453.*October 28, 2026.*Transport Occupations.*150 invitations.*CRS 477/s);
  assert.ok(r.indexOf("#453") < r.indexOf("#452") && r.indexOf("#452") < r.indexOf("#451"));
  assert.ok(!r.includes("#450"), "three draws");
  assert.ok(r.includes(EE_ROUNDS_URL));
});

test("schema drift or a failed fetch abstains with the official link (no stale or invented number)", async () => {
  for (const overrides of [{ ptime: JSON.stringify({ study: { IN: 7 } }) }, { ptime: new Error("ECONNRESET") }, { ptime: "<html>maintenance</html>" }]) {
    const live = createLiveData({ fetch: fakeFetch(overrides) });
    const r = await live.answer({ kind: "ptime", category: "study", country: "India" });
    assert.match(r, /couldn't load IRCC's live processing times/i);
    assert.ok(r.includes(PTIME_TOOL_URL));
  }
  const live = createLiveData({ fetch: fakeFetch({ rounds: JSON.stringify({ rounds: [{ foo: 1 }] }) }) });
  assert.match(await live.answer({ kind: "draws" }), /couldn't load IRCC's latest Express Entry draws/i);
});

test("feeds are cached for an hour (one fetch per feed)", async () => {
  let n = 0;
  const f = fakeFetch();
  const live = createLiveData({ fetch: async (u) => (n++, f(u)) });
  await live.answer({ kind: "ptime", category: "study", country: "India" });
  await live.answer({ kind: "ptime", category: "work", country: "India" });
  assert.equal(n, 2, "ptime + country names, once each");
});
