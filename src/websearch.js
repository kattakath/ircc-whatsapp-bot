import * as cheerio from "cheerio";
import { persistChunk } from "./db.js";

const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SITE_SCOPE = "site:canada.ca/en/immigration-refugees-citizenship";

// FIX-06: the ONLY pages the fallback may read or persist. An exact hostname, not a suffix
// test (`evil-canada.ca`, `canada.ca.example.com`), plus the IRCC path prefix; checked on
// the search result AND on the final URL after redirects, before parsing or persisting.
const ALLOWED_HOST = "www.canada.ca";
const ALLOWED_PATH_PREFIX = "/en/immigration-refugees-citizenship/";
export function isAllowedUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === ALLOWED_HOST && url.pathname.startsWith(ALLOWED_PATH_PREFIX);
}

// CRAG's web-search fallback exists to avoid the LLM hallucinating from
// parametric knowledge when local retrieval is weak — it substitutes
// ungrounded generation with a *different authoritative source*, not with
// open-web/general knowledge. Scoping every query to canada.ca keeps that
// property: whatever comes back is still an official government page, just
// one not yet in the local RAG store.

async function search(question) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    // site: FIRST, so a long question cannot push the scope out of the query (S11).
    body: JSON.stringify({ q: `${SITE_SCOPE} ${question}` }),
    signal: AbortSignal.timeout(15_000), // per-call deadline (FIX-03)
  });
  if (!res.ok) {
    throw new Error(`Serper search failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data.organic ?? []).filter((r) => isAllowedUrl(r.link)).slice(0, 2);
}

async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ircc-whatsapp-bot/0.1)" },
    signal: AbortSignal.timeout(15_000), // per-call deadline (FIX-03)
  });
  if (!res.ok) return null;
  // A canada.ca URL can redirect anywhere: judge where we actually landed (S55).
  if (!isAllowedUrl(res.url || url)) return null;
  const html = await res.text();
  const $ = cheerio.load(html);
  $("nav, footer, script, style, noscript, svg, header").remove();
  const title = $("h1").first().text().trim() || $("title").text().trim();
  const text = $("main").text().trim() || $("body").text().trim();
  // Collapse excess whitespace left over from stripped layout elements.
  const cleaned = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text: cleaned };
}

/**
 * Falls back to a live, canada.ca-scoped web search when local RAG
 * retrieval graded poorly. Returns chunk-shaped objects compatible with
 * synthesize() — same {content, metadata, similarity} shape retrieve()
 * produces — so the LLM prompt path and grounding discipline don't change,
 * only the source of the content does.
 */
export async function webFallback(question) {
  if (!SERPER_API_KEY) {
    console.error("SERPER_API_KEY not set — skipping web fallback.");
    return [];
  }

  let results;
  try {
    results = await search(question);
  } catch (err) {
    console.error("Web fallback search failed:", err);
    return [];
  }

  const chunks = [];
  for (const result of results) {
    let page;
    try {
      page = await fetchPageText(result.link);
    } catch (err) {
      console.error(`Web fallback fetch failed for ${result.link}:`, err);
      continue;
    }
    if (!page || page.text.length < 100) continue;

    chunks.push({
      content: page.text.slice(0, 4000), // cap: bounds the prompt and the persisted item
      metadata: {
        source: "ircc-live",
        url: result.link,
        title: page.title || result.title,
      },
      similarity: null, // not from vector search — grading already happened upstream
      live: true, // fetched just now, not retrieved — llm.js labels its provenance from this
    });
  }

  return chunks;
}

/**
 * Self-learning step: persist each web-fallback page into the AI Search store
 * as ONE `ircc-live` item, so a similar future question is answered from
 * retrieval instead of triggering another live search. One upload per page, not
 * per paragraph: the item is keyed by its URL, so per-piece uploads would each
 * overwrite the last — and the store chunks and embeds the page itself.
 * Best-effort — a failure here shouldn't break the answer that already went out.
 */
export async function persistWebFallback(chunks) {
  for (const chunk of chunks) {
    // Defence in depth: never write an off-allowlist page into the corpus, where it would count as official.
    if (!isAllowedUrl(chunk.metadata?.url)) continue;
    try {
      await persistChunk(chunk.content, {
        url: chunk.metadata.url,
        title: chunk.metadata.title,
      });
    } catch (err) {
      console.error(`Failed to persist web-fallback content for ${chunk.metadata.url}:`, err);
    }
  }
}
