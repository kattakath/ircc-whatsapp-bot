import * as cheerio from "cheerio";
import { persistChunk } from "./db.js";

const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SITE_SCOPE = "site:canada.ca/en/immigration-refugees-citizenship";

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
    body: JSON.stringify({ q: `${question} ${SITE_SCOPE}` }),
    signal: AbortSignal.timeout(15_000), // per-call deadline (FIX-03)
  });
  if (!res.ok) {
    throw new Error(`Serper search failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data.organic ?? []).slice(0, 2);
}

async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ircc-whatsapp-bot/0.1)" },
    signal: AbortSignal.timeout(15_000), // per-call deadline (FIX-03)
  });
  if (!res.ok) return null;
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
