// Retrieval + CRAG write-back against the Cloudflare AI Search instance
// (src/aisearch.js). The LangGraph checkpointer is NOT here: it stays on the
// local Postgres at RAGDB_URI (src/index.js, src/simulate.js).
import { contentHash, itemBody, itemKey, searchChunks, upsertItem } from "./aisearch.js";

// The instance is SHARED with the operator's other corpora (repo docs, web
// pages, notes). Everything this bot retrieves is scoped to these two, so a
// WhatsApp user is only ever answered from canada.ca content.
export const IRCC_CORPORA = ["ircc", "ircc-live"];
export const LIVE_CORPUS = "ircc-live";

// Applied to the VECTOR score (scoring_details.vector_score — cosine similarity
// from the instance's embedding model). The instance is hybrid, and its top-level
// `score` is a fused rank (RRF: the top hit always scores 1), not a similarity,
// so it cannot carry this floor or graph.js's GRADE_THRESHOLD.
//
// Re-tuned 2026-11-19 for AI Search's qwen3-embedding-0.6b (scripts/threshold-probe.mjs,
// 24 covered questions, 175 chunks): no top-8 chunk of a covered question scored
// below 0.40, so the old 0.3 dropped nothing. At 0.45 the floor drops 6 of 63
// other-topic chunks and 2 of 112 relevant ones; it matters most when the live
// fallback is empty and synthesis falls back to these local chunks.
const SIMILARITY_FLOOR = 0.45;

/** The `filters` object for a search, or the equality form when there is one value. */
export function buildFilters(sources) {
  if (sources && sources.length === 1) return { source: sources[0] };
  if (sources && sources.length > 1) return { source: { $in: sources } };
  return { corpus: { $in: IRCC_CORPORA } };
}

/**
 * Retrieve the top-k IRCC chunks for a question, optionally scoped to one or
 * more `source` values (e.g. ["ircc-crawl-pr", "ircc-crawl-citizenship"]).
 *
 * Returns `[{ content, metadata, similarity }]` in the instance's hybrid rank
 * order. `similarity` is the chunk's vector score, or null for a keyword-only
 * hit (no vector score exists for those; they are kept, because exact program
 * names and form numbers are what the keyword index is for). A vector hit below
 * SIMILARITY_FLOOR is dropped.
 *
 * The scope is ALSO enforced client-side, on each chunk's own metadata, so a
 * filter the API accepted but did not apply can never leak another corpus in.
 */
export async function retrieve(question, { sources = null, limit = 8 } = {}) {
  const chunks = await searchChunks(question, {
    maxResults: limit,
    matchThreshold: SIMILARITY_FLOOR,
    filters: buildFilters(sources),
  });

  const wanted = sources && sources.length > 0 ? new Set(sources) : null;
  return chunks
    .filter((c) => {
      const md = c.item?.metadata ?? {};
      if (!IRCC_CORPORA.includes(md.corpus)) return false;
      return wanted ? wanted.has(md.source) : true;
    })
    .map((c) => {
      const vector = c.scoring_details?.vector_score;
      return {
        content: c.text,
        metadata: {
          corpus: c.item.metadata.corpus,
          source: c.item.metadata.source,
          url: c.item.metadata.url,
          title: c.item.metadata.title,
          key: c.item.key,
        },
        similarity: typeof vector === "number" ? vector : null,
      };
    })
    .filter((c) => c.similarity == null || c.similarity >= SIMILARITY_FLOOR);
}

/** The best vector similarity in a retrieved set, or 0 — what graph.js grades on. */
export function topSimilarity(chunks) {
  return chunks.reduce((best, c) => (c.similarity != null && c.similarity > best ? c.similarity : best), 0);
}

/**
 * Persists one CRAG web-fallback page as ONE item (corpus `ircc-live`), so a
 * repeat of a similar question hits retrieval next time instead of triggering
 * another live search. Keyed by the page URL when there is one — the same key
 * the export gave the existing `ircc-live` pages, so a re-fetch overwrites
 * rather than duplicates — else by a hash of the content.
 */
export async function persistChunk(content, metadata = {}) {
  const ident = metadata.url ?? contentHash(content);
  return upsertItem({
    key: itemKey(LIVE_CORPUS, ident),
    body: itemBody({ title: metadata.title, url: metadata.url, text: content }),
    metadata: {
      corpus: LIVE_CORPUS,
      source: "ircc-live",
      ...(metadata.url ? { url: metadata.url } : {}),
      ...(metadata.title ? { title: metadata.title } : {}),
    },
  });
}

/** Nothing to close any more (HTTP, no pool); kept so callers need not change. */
export async function closeDb() {}
