// FIX-06: the web fallback reads and persists only canada.ca IRCC pages (S11, S55).
// fetch is mocked; nothing leaves the process.
process.env.SERPER_API_KEY = "test-not-a-key";
const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { isAllowedUrl, webFallback } = await import("../src/websearch.js");

const IRCC = "https://www.canada.ca/en/immigration-refugees-citizenship/services/x.html";
const page = (title) => `<html><body><main><h1>${title}</h1>${"Official IRCC text. ".repeat(20)}</main></body></html>`;

function mockFetch({ organic, pages }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    if (String(url).startsWith("https://google.serper.dev/")) {
      return { ok: true, json: async () => ({ organic }), text: async () => "" };
    }
    const p = pages[String(url)];
    if (!p) throw new Error(`unexpected fetch ${url}`);
    return { ok: true, url: p.finalUrl ?? String(url), text: async () => page(p.title) };
  };
  return calls;
}

test("isAllowedUrl: exact host + IRCC path, https only", () => {
  assert.equal(isAllowedUrl(IRCC), true);
  for (const bad of [
    "http://www.canada.ca/en/immigration-refugees-citizenship/x.html",
    "https://canada.ca/en/immigration-refugees-citizenship/x.html",
    "https://www.canada.ca/en/revenue-agency/x.html",
    "https://evil-canada.ca/en/immigration-refugees-citizenship/x.html",
    "https://www.canada.ca.example.com/en/immigration-refugees-citizenship/x.html",
    "https://example.com/x",
    "not a url",
    undefined,
  ]) assert.equal(isAllowedUrl(bad), false, String(bad));
});

test("S11: site: comes first, and an off-domain result is neither fetched nor returned", async () => {
  const q = "word ".repeat(60).trim() + " about study permits?";
  const calls = mockFetch({ organic: [{ link: "https://example.com/x", title: "x" }, { link: IRCC, title: "IRCC" }], pages: { [IRCC]: { title: "IRCC page" } } });
  const chunks = await webFallback(q);
  assert.ok(JSON.parse(calls[0].body).q.startsWith("site:canada.ca/en/immigration-refugees-citizenship "));
  assert.ok(!calls.some((c) => c.url.startsWith("https://example.com")), "example.com was fetched");
  assert.deepEqual(chunks.map((c) => c.metadata.url), [IRCC]);
});

test("S55: a canada.ca result that redirects off the allowlist is dropped", async () => {
  mockFetch({ organic: [{ link: IRCC, title: "IRCC" }], pages: { [IRCC]: { title: "Moved", finalUrl: "https://example.com/landing" } } });
  assert.deepEqual(await webFallback("What is a study permit?"), []);
});
