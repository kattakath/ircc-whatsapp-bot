import pg from "pg";
import assert from "node:assert/strict";
import test, { after } from "node:test";

const fixtureRows = [
  { content: "IRCC fixture", metadata: { source: "ircc-crawl-pr" }, similarity: 0.7 },
  { content: "Citizenship fixture", metadata: { source: "ircc-crawl-citizenship" }, similarity: 0.6 },
  { content: "IRCC live fixture", metadata: { source: "ircc-live" }, similarity: 0.4 },
  { content: "unrelated fixture", metadata: { source: "nix-manual" }, similarity: 0.9 },
  { content: "private fixture", metadata: { source: "private-docs" }, similarity: 0.99 },
];

const originalQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = async function (sql, params) {
  let rows = fixtureRows;

  if (sql.includes("WHERE metadata->>'source' LIKE 'ircc-%'")) {
    rows = rows.filter((row) => row.metadata.source.startsWith("ircc-"));
  } else {
    const match = sql.match(/WHERE metadata->>'source' = ANY\(\$(\d+)::text\[\]\)/);
    if (match) {
      const sources = params[Number(match[1]) - 1];
      rows = rows.filter((row) => sources.includes(row.metadata.source));
    }
  }

  return { rows: rows.slice(0, params.at(-1)) };
};

const { retrieve, closeDb } = await import("../src/db.js");

after(async () => {
  pg.Pool.prototype.query = originalQuery;
  await closeDb();
});

test("20 off-domain and ambiguous probes stay restricted to IRCC sources", async () => {
  const questions = [
    "What was the minimum CRS score in the most recent Express Entry draw?",
    "What is the latest Express Entry draw score?",
    "How do I configure nix-darwin to use Homebrew?",
    "Which GPU is best for local LLM inference under $1000?",
    "How do I debug a Rust borrow checker error?",
    "What is the current Bitcoin price?",
    "How much does a Tesla Model 3 cost?",
    "Why is my Kubernetes pod restarting?",
    "What does a Python KeyError mean?",
    "Which laptop should I buy for video editing?",
    "How do I file taxes in the United States?",
    "What are common symptoms of seasonal allergies?",
    "How can I improve Wi-Fi coverage at home?",
    "What is the capital of Australia?",
    "Who won the latest Premier League match?",
    "How do I renew a Canadian passport?",
    "Can I work remotely from Mexico on a Canadian visitor visa?",
    "What are the steps to start a small business in Canada?",
    "What is the current minimum wage in Ontario?",
    "What will the weather be tomorrow?",
  ];

  assert.equal(questions.length, 20);
  for (const question of questions) {
    const rows = await retrieve(question);
    const sources = rows.map((row) => row.metadata.source);

    assert.ok(sources.length > 0, question);
    assert.ok(sources.every((source) => source.startsWith("ircc-")), question);
    assert.deepEqual(sources, ["ircc-crawl-pr", "ircc-crawl-citizenship", "ircc-live"], question);
  }
});

test("an empty source list keeps the safe IRCC-only default", () => {
  return retrieve("ambiguous question", { sources: [] }).then((rows) => {
    assert.deepEqual(rows.map((row) => row.metadata.source), [
      "ircc-crawl-pr",
      "ircc-crawl-citizenship",
      "ircc-live",
    ]);
  });
});

test("topic branches remain restricted to their exact configured sources", async () => {
  const sources = ["ircc-crawl-pr", "ircc-crawl-citizenship"];
  const rows = await retrieve("profile question", { sources, limit: 5 });

  assert.deepEqual(rows.map((row) => row.metadata.source), ["ircc-crawl-pr", "ircc-crawl-citizenship"]);
});
