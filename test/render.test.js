// FIX-04: the deterministic WhatsApp renderer (S07, S08) and the prompt contract.
process.env.OPENAI_API_KEY = "test-not-a-key";
const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { renderAnswer, toWhatsApp } = await import("../src/render.js");
const { checkReply } = await import("./dialogue/oracle.js");
const { SYSTEM_PROMPT } = await import("../src/llm.js");

const ETA = "https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada/eta.html";
const VISIT = "https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada.html";
const chunk = (url, similarity) => ({ content: "c", similarity, metadata: { url } });

test("S07: model Markdown renders to WhatsApp and passes the oracle", () => {
  const md = "## Fees\n\n**Fee:** $7 [1]\n\n*Note:* online only\n\n| Item | Cost |\n|---|---|\n| eTA | $7 |\n\n1. Apply online\n2. Pay the fee\n\nUse form `IMM 5257`.";
  const { text } = renderAnswer(md, [chunk(ETA, 0.8)]);
  for (const want of ["*Fees*", "*Fee:* $7", "_Note:_ online only", "• eTA — $7", "Step 1: Apply online", "Step 2: Pay the fee", "Use form IMM 5257"]) {
    assert.ok(text.includes(want), `missing ${JSON.stringify(want)} in\n${text}`);
  }
  assert.ok(!text.includes("**") && !text.includes("|") && !text.includes("`"));
  assert.ok(!/^\s*#/m.test(text) && !/^\s*\d+\.\s/m.test(text));
  assert.deepEqual(checkReply(text, { retrievedUrls: [ETA] }), []);
});

test("S08: an invented URL is stripped; sources come from metadata", () => {
  const r = renderAnswer("You may need a visa [1]. See https://www.canadaca.ca/visit", [chunk(VISIT, 0.7)]);
  assert.ok(!r.text.includes("canadaca.ca"));
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.sources, [VISIT]);
  assert.ok(r.text.includes(`🔗 ${VISIT}`));
});

test("S08: an answer with NO [n] markers is still sent, with the top 2 retrieved sources", () => {
  const chunks = [chunk(VISIT, 0.61), chunk(ETA, 0.9), chunk("https://example.com/x", 0.95)];
  const r = renderAnswer("You can apply for a visitor record before your status expires.", chunks);
  assert.equal(r.zeroMarkers, true);
  assert.deepEqual(r.sources, [ETA, VISIT], "top 2 by grade, canada.ca only");
  assert.match(r.text, /^You can apply/);
});

test("cited [n] markers pick the sources, in order of first use, ignoring out-of-range ones", () => {
  const r = renderAnswer("A [2]. B [1]. C [9].", [chunk(VISIT, 0.9), chunk(ETA, 0.7)]);
  assert.deepEqual(r.sources, [ETA, VISIT]);
});

test("a named link to a dropped URL keeps its words; an allowed one keeps both", () => {
  assert.equal(toWhatsApp("[the fee page](https://evil.example/x)", { allow: () => false, dropped: 0 }), "the fee page");
  assert.equal(toWhatsApp(`[eTA](${ETA})`, { allow: () => true, dropped: 0 }), `eTA: ${ETA}`);
});

test("S07: SYSTEM_PROMPT asks for plain Markdown, [n] citations and no URLs", () => {
  assert.ok(!/single asterisks/i.test(SYSTEM_PROMPT));
  assert.match(SYSTEM_PROMPT, /plain standard Markdown/);
  assert.match(SYSTEM_PROMPT, /\[1\]/);
  assert.match(SYSTEM_PROMPT, /Do NOT write any URLs/);
});

test("[n] markers pick the sources but never show, even on their own line", () => {
  const r = renderAnswer("You need 1,095 days [1][2].\n\nTime as a temporary resident counts half [2].\n\n[2]", [chunk(ETA, 0.9), chunk(VISIT, 0.8)]);
  assert.ok(!/\[\d+\]/.test(r.text), r.text);
  assert.deepEqual(r.sources, [ETA, VISIT]);
  assert.match(r.text, /You need 1,095 days\.\n\nTime as a temporary resident counts half\.\n\n🔗 /);
});

test("no space is left before punctuation where a marker was stripped", () => {
  const r = renderAnswer("You can ask to have them added at no fee [3] . Then apply [1] , and wait [2]!", [chunk(ETA, 0.9), chunk(VISIT, 0.8), chunk(ETA, 0.7)]);
  assert.match(r.text, /^You can ask to have them added at no fee\. Then apply, and wait!/);
});

test("gpt-oss's full-width markers (【1】, 【2†L3-L5】) pick sources and never show (seen live 2026-11-20)", () => {
  const r = renderAnswer("Visitors can stay up to 6 months.\n\n*Note:* talk to a licensed professional.【2】 Fees apply【1†L3-L5】.", [chunk(VISIT, 0.9), chunk(ETA, 0.8)]);
  assert.ok(!/【|】|†/.test(r.text), r.text);
  assert.match(r.text, /licensed professional\. Fees apply\./);
  assert.deepEqual(r.sources, [ETA, VISIT]);
  assert.equal(r.zeroMarkers, false);
});
