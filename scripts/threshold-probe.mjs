// Re-measure the two retrieval thresholds against the LIVE AI Search instance.
// Read-only (search calls only; ~70 semantic queries per run). Not a test: it needs
// CF_ACCOUNT_ID and a token (env CLOUDFLARE_AI_SEARCH_TOKEN, else the Keychain), so
// run it by hand after a re-crawl or an embedding-model change:
//
//   node scripts/threshold-probe.mjs
//
// It reports, for the grade (graph.js GRADE_THRESHOLD): the best vector score of
// labelled questions in three classes (A covered by the crawl, B current/specific,
// C off-topic) and, for the floor (db.js SIMILARITY_FLOOR): per-chunk scores of
// covered questions, split by whether the chunk is from the right topic.
// The questions are synthetic on purpose: real conversations are people's data.
import { searchChunks } from "../src/aisearch.js";

// A: covered by the canada.ca crawl; `want` = a URL fragment of the right page.
const A = [
  ["How do I renew my adult passport?", "canadian-passports"],
  ["How much does a child passport cost?", "canadian-passports"],
  ["My passport was stolen, what should I do?", "lost-stolen"],
  ["How do I apply for permanent residence through Express Entry?", "express-entry"],
  ["What is the Comprehensive Ranking System?", "express-entry"],
  ["How do I sponsor my spouse to immigrate to Canada?", "family-sponsorship"],
  ["Can I sponsor my parents and grandparents?", "family-sponsorship"],
  ["How do I apply for a study permit?", "study-permit"],
  ["Can I work while studying in Canada?", "study"],
  ["What is a post-graduation work permit?", "post-graduation"],
  ["How do I extend my study permit?", "study-permit"],
  ["How do I apply for a work permit?", "work-permit"],
  ["What is an open work permit?", "open-work-permit"],
  ["Do I need an eTA to fly to Canada?", "eta"],
  ["How do I apply for a visitor visa?", "visit-canada"],
  ["Can I extend my stay as a visitor?", "visit-canada"],
  ["How do I apply for Canadian citizenship?", "citizenship"],
  ["What is on the citizenship test?", "citizenship"],
  ["How many days do I need in Canada to become a citizen?", "citizenship"],
  ["How do I renew my permanent resident card?", "pr-card"],
  ["What is the residency obligation for permanent residents?", "pr-card"],
  ["How do I claim refugee protection in Canada?", "refugees"],
  ["What is the Provincial Nominee Program?", "provincial-nominees"],
  ["How do I check my application status?", "check-status"],
];
// B: Canadian immigration, but current or specific data a static crawl may not hold.
const B = [
  "What was the CRS cutoff in the most recent Express Entry draw?",
  "What are today's processing times for spousal sponsorship?",
  "Is the IRCC office in Mississauga open on Saturdays?",
  "Did IRCC announce new immigration levels this week?",
  "How long is the current wait for a citizenship ceremony in Calgary?",
  "What changed in the study permit cap announced this month?",
];
// C: off-topic for this bot.
const C = [
  "What is the best pizza place in Toronto?",
  "How do I apply for a US H-1B visa?",
  "How do I get an Australian working holiday visa?",
  "What is the weather in Vancouver tomorrow?",
  "How do I configure a launchd agent in nix-darwin?",
  "Can you recommend a good laptop for programming?",
  "How do I file my US federal tax return?",
  "What is the capital of France?",
  "How do I reset my Gmail password?",
  "Translate hello into Spanish",
  "How do I bake sourdough bread?",
  "Who won the Stanley Cup last year?",
  "How do I apply for a UK student visa?",
  "What are the rules for renting an apartment in Montreal?",
];

// The same scope retrieve() uses when no topic branch narrows it.
const filters = { corpus: { $in: ["ircc", "ircc-live"] } };
const search = (q) => searchChunks(q, { maxResults: 8, matchThreshold: 0, filters });
const vec = (c) => (typeof c.scoring_details?.vector_score === "number" ? c.scoring_details.vector_score : null);

function best(chunks) {
  let b = 0, url = "";
  for (const c of chunks) {
    const v = vec(c);
    if (v != null && v > b) { b = v; url = c.item?.metadata?.url || c.item?.key || ""; }
  }
  return { best: b, url };
}
function stats(v) {
  const s = [...v].sort((x, y) => x - y);
  const p = (f) => Number(s[Math.floor((s.length - 1) * f)].toFixed(3));
  return { n: s.length, min: p(0), p10: p(0.1), median: p(0.5), max: p(1) };
}

const rows = [];
const relevant = [], other = [];
for (const [q, want] of A) {
  const chunks = await search(q);
  const b = best(chunks);
  rows.push({ cls: "A", q, best: b.best, right: b.url.includes(want) });
  for (const c of chunks) {
    const v = vec(c);
    if (v != null) ((c.item?.metadata?.url || "").includes(want) ? relevant : other).push(v);
  }
}
for (const q of B) rows.push({ cls: "B", q, best: best(await search(q)).best });
for (const q of C) rows.push({ cls: "C", q, best: best(await search(q)).best });

for (const r of [...rows].sort((x, y) => y.best - x.best)) {
  const tag = r.cls === "A" ? (r.right ? "ok" : "WRONG PAGE") : "";
  console.log(`${r.best.toFixed(3)}  ${r.cls}  ${r.q.slice(0, 60).padEnd(60)}  ${tag}`);
}
const okA = rows.filter((r) => r.cls === "A" && r.right).map((r) => r.best);
const offC = rows.filter((r) => r.cls === "C").map((r) => r.best);
console.log("\ngrade:", JSON.stringify({
  coveredRightPage: stats(okA),
  offTopic: stats(offC),
  // A threshold in (max off-topic, min covered] separates them; report both edges.
  lowestCoveredRightPage: Math.min(...okA).toFixed(3),
  highestOffTopic: Math.max(...offC).toFixed(3),
}));
const drop = (v, t) => v.filter((x) => x < t).length;
console.log("floor:", JSON.stringify({
  relevantChunks: stats(relevant),
  otherChunks: stats(other),
  droppedAt: Object.fromEntries([0.3, 0.4, 0.45, 0.5, 0.55].map((t) => [t, `${drop(relevant, t)} relevant / ${drop(other, t)} other`])),
}));
