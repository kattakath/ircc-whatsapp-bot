// Offline unit tests: `fetch` is mocked in every test that would make a call,
// so nothing here reaches the live Cloudflare AI Search API. Run: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { itemBody, itemKey, listItems, resetConfig } from "../src/aisearch.js";
import { buildFilters, persistChunk, retrieve, topSimilarity } from "../src/db.js";
import { pageItem, planStale } from "../scripts/crawl-pages.js";

const FAKE_ACCOUNT = "0123456789abcdef0123456789abcdef";
const BASE = `https://api.cloudflare.com/client/v4/accounts/${FAKE_ACCOUNT}/ai-search/namespaces/default/instances/rag`;

const realFetch = globalThis.fetch;
let calls;

function mockFetch(respond) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = respond(String(url), init);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

beforeEach(() => {
  process.env.CF_ACCOUNT_ID = FAKE_ACCOUNT;
  process.env.CLOUDFLARE_AI_SEARCH_TOKEN = "test-token-not-real";
  delete process.env.CF_AI_SEARCH_INSTANCE;
  resetConfig();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("itemKey — must match the export's Python byte for byte", () => {
  // Vectors computed by running the export's Python `item_key` (see the comment
  // in src/aisearch.js). The first is also the key of the live item for that page.
  const vectors = [
    [
      "ircc",
      "https://www.canada.ca/en/immigration-refugees-citizenship/services/canadian-citizenship.html",
      "ircc/www.canada.ca_en_immigration-refugees-citizenship_services_canadian-citizenship.html-1a447c4565.md",
    ],
    [
      // Long enough to be truncated to the 128-char key limit.
      "ircc",
      "https://www.canada.ca/en/immigration-refugees-citizenship/services/immigrate-canada/express-entry/eligibility/criteria-comprehensive-ranking-system/grid.html",
      "ircc/www.canada.ca_en_immigration-refugees-citizenship_services_immigrate-canada_express-entry_eligibility_criteri-8aa66d304a.md",
    ],
    [
      "ircc-live",
      "https://www.canada.ca/en/immigration-refugees-citizenship/services/study-canada/study-permit.html",
      "ircc-live/www.canada.ca_en_immigration-refugees-citizenship_services_study-canada_study-permit.html-8af376dafd.md",
    ],
    [
      // Query string, a space, a percent-escape and a trailing slash: exercises
      // the substitution and both-ends strip.
      "ircc",
      "https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada.html?utm=a b&x=%20/",
      "ircc/www.canada.ca_en_immigration-refugees-citizenship_services_visit-canada.html-utm-a-b-x-20-fc83c81714.md",
    ],
  ];

  for (const [corpus, url, expected] of vectors) {
    test(expected.slice(0, 60), () => {
      const key = itemKey(corpus, url);
      assert.equal(key, expected);
      assert.ok(key.length <= 128);
    });
  }

  test("an identifier that slugs to nothing becomes 'doc'", () => {
    assert.match(itemKey("ircc", "https://///"), /^ircc\/doc-[0-9a-f]{10}\.md$/);
  });
});

test("itemBody is the export's file format", () => {
  assert.equal(
    itemBody({ title: "T", url: "https://x.test/a", text: "page text" }),
    "# T\n\nSource: https://x.test/a\n\npage text\n"
  );
});

describe("retrieve", () => {
  const chunk = (corpus, source, scoring, text = "t") => ({
    text,
    score: 1,
    item: { key: `${corpus}/k.md`, metadata: { corpus, source, url: "https://u.test", title: "T" } },
    scoring_details: scoring,
  });

  test("one source → equality filter; floor, limit and auth header sent", async () => {
    mockFetch(() => ({ success: true, result: { chunks: [] } }));
    await retrieve("q", { sources: ["ircc-crawl-pr"], limit: 3 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/search`);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer test-token-not-real");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      query: "q",
      ai_search_options: {
        retrieval: { max_num_results: 3, match_threshold: 0.3, filters: { source: "ircc-crawl-pr" } },
      },
    });
  });

  test("filters: several sources → $in; none → scoped to the IRCC corpora", () => {
    assert.deepEqual(buildFilters(["a", "b"]), { source: { $in: ["a", "b"] } });
    assert.deepEqual(buildFilters(null), { corpus: { $in: ["ircc", "ircc-live"] } });
  });

  test("maps to {content, metadata, similarity} and enforces the scope client-side", async () => {
    mockFetch(() => ({
      success: true,
      result: {
        chunks: [
          chunk("ircc", "ircc-crawl-pr", { keyword_score: 6.3, keyword_rank: 1 }, "keyword hit"),
          chunk("repo", "nix-config", { vector_score: 0.9 }, "other corpus — must never reach a user"),
          chunk("ircc-live", "ircc-live", { vector_score: 0.71 }, "live page"),
          chunk("ircc", "ircc-crawl-pr", { vector_score: 0.2 }, "below the floor"),
        ],
      },
    }));
    const out = await retrieve("q");
    assert.deepEqual(
      out.map((c) => [c.content, c.similarity]),
      [
        ["keyword hit", null],
        ["live page", 0.71],
      ]
    );
    assert.equal(out[1].metadata.url, "https://u.test");
    assert.equal(out[1].metadata.title, "T");
    assert.equal(topSimilarity(out), 0.71);
  });

  test("with sources, a chunk from another source is dropped even if the API returned it", async () => {
    mockFetch(() => ({
      success: true,
      result: { chunks: [chunk("ircc", "ircc-crawl-work", { vector_score: 0.8 }), chunk("ircc", "ircc-crawl-pr", { vector_score: 0.6 })] },
    }));
    const out = await retrieve("q", { sources: ["ircc-crawl-pr"] });
    assert.deepEqual(out.map((c) => c.metadata.source), ["ircc-crawl-pr"]);
  });

  test("an API error throws instead of returning an empty (\"don't know\") result", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 1 }] }), { status: 400 });
    await assert.rejects(retrieve("q"), /AI Search POST \/search failed: 400/);
  });

  test("a missing account id fails loudly, before any request", async () => {
    delete process.env.CF_ACCOUNT_ID;
    resetConfig();
    mockFetch(() => ({}));
    await assert.rejects(retrieve("q"), /CF_ACCOUNT_ID/);
    assert.equal(calls.length, 0);
  });

  test("CF_AI_SEARCH_INSTANCE overrides the instance id", async () => {
    process.env.CF_AI_SEARCH_INSTANCE = "other";
    resetConfig();
    mockFetch(() => ({ success: true, result: { chunks: [] } }));
    await retrieve("q");
    assert.ok(calls[0].url.endsWith("/instances/other/search"));
  });
});

describe("persistChunk — one ircc-live item per page", () => {
  test("keyed by URL, export body, custom metadata only", async () => {
    mockFetch(() => ({ success: true, result: { id: "abc" } }));
    const url = "https://www.canada.ca/en/immigration-refugees-citizenship/services/study-canada/study-permit.html";
    await persistChunk("page text", { source: "ircc-live", url, title: "Study permit" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/items`);
    const form = calls[0].init.body;
    const file = form.get("file");
    assert.equal(
      file.name,
      "ircc-live/www.canada.ca_en_immigration-refugees-citizenship_services_study-canada_study-permit.html-8af376dafd.md"
    );
    assert.equal(file.type, "text/markdown");
    assert.equal(await file.text(), `# Study permit\n\nSource: ${url}\n\npage text\n`);
    assert.deepEqual(JSON.parse(form.get("metadata")), {
      corpus: "ircc-live",
      source: "ircc-live",
      url,
      title: "Study permit",
    });
  });

  test("no URL → a stable content-hash key", async () => {
    mockFetch(() => ({ success: true, result: {} }));
    await persistChunk("same text", {});
    await persistChunk("same text", {});
    const [a, b] = calls.map((c) => c.init.body.get("file").name);
    assert.equal(a, b);
    assert.match(a, /^ircc-live\/[0-9a-f]{40}-[0-9a-f]{10}\.md$/);
  });
});

test("listItems walks every page and checks the total", async () => {
  const all = Array.from({ length: 73 }, (_, i) => ({ id: `id${i}`, key: `ircc/p${i}.md` }));
  mockFetch((url) => {
    const q = new URL(url).searchParams;
    const page = Number(q.get("page"));
    const per = Number(q.get("per_page"));
    assert.equal(q.get("search"), "ircc/");
    assert.ok(per <= 50, "the API rejects per_page > 50");
    return {
      success: true,
      result: all.slice((page - 1) * per, page * per),
      result_info: { page, per_page: per, total_count: all.length },
    };
  });
  const out = await listItems({ search: "ircc/" });
  assert.equal(out.length, 73);
  assert.equal(calls.length, 2);
});

describe("crawl ingest", () => {
  test("pageItem: one upload per page with the crawl metadata; short pages skipped", () => {
    const url = "https://www.canada.ca/en/immigration-refugees-citizenship/services/canadian-citizenship/become-canadian-citizen.html";
    const up = pageItem({ url, markdown: "# Become a citizen\n\n" + "x".repeat(200) }, "ircc-crawl");
    assert.equal(up.key, itemKey("ircc", url));
    assert.deepEqual(up.metadata, {
      corpus: "ircc",
      source: "ircc-crawl-citizenship",
      url,
      title: "Become a citizen",
    });
    assert.ok(up.body.startsWith(`# Become a citizen\n\nSource: ${url}\n\n`));
    assert.equal(pageItem({ url, markdown: "too short" }, "ircc-crawl"), null);
  });

  const item = (key, source) => ({ id: `id:${key}`, key, metadata: source ? { source } : null });
  const listed = [
    item("ircc/a.md", "ircc-crawl-pr"),
    item("ircc/b.md", "ircc-crawl-work"),
    item("ircc/gone.md", "ircc-crawl-visit"),
    item("ircc/queued.md", null),
    item("ircc-live/a.md", "ircc-live"),
    item("web/ircc/x.md", "web"),
  ];

  test("planStale deletes only ircc/ crawl items the new crawl lacks — never ircc-live", () => {
    const { stale, skipped, refusal } = planStale(listed, ["ircc/a.md", "ircc/b.md"], { tagPrefix: "ircc-crawl" });
    assert.equal(refusal, null);
    assert.deepEqual(stale.map((s) => s.key), ["ircc/gone.md"]);
    assert.deepEqual(skipped, ["ircc/queued.md"]);
  });

  test("planStale never selects an ircc-live item, even when the crawl kept nothing like it", () => {
    const onlyLive = [item("ircc-live/a.md", "ircc-crawl-pr"), item("ircc-live/b.md", "ircc-live")];
    const { stale } = planStale(onlyLive, [], { tagPrefix: "ircc-crawl" });
    assert.deepEqual(stale, []);
  });

  test("planStale refuses after a failed upload, or for an implausibly small crawl", () => {
    assert.match(planStale(listed, ["ircc/a.md", "ircc/b.md"], { tagPrefix: "ircc-crawl", failedUploads: 1 }).refusal, /failed/);
    const many = Array.from({ length: 10 }, (_, i) => item(`ircc/p${i}.md`, "ircc-crawl-pr"));
    const r = planStale(many, ["ircc/p0.md"], { tagPrefix: "ircc-crawl" });
    assert.deepEqual(r.stale, []);
    assert.match(r.refusal, /kept 1 page/);
  });

  test("planStale refuses on an unexpected item shape", () => {
    assert.match(planStale([{ key: "ircc/a.md" }], [], { tagPrefix: "ircc-crawl" }).refusal, /shape/);
  });
});
