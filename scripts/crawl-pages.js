// Shared by scripts/ingest-crawl.js (plain CLI) and scripts/inngest/functions.js
// (durable version) — keep both ingestion paths consistent.
//
// One crawled page = ONE AI Search item. The store chunks and embeds it itself,
// so there is no chunking here any more. The item key comes from the page URL
// (src/aisearch.js `itemKey`), identical to the key the operator's export gave
// it, so re-ingesting a page overwrites its item instead of adding a duplicate.
import { deleteItem, itemBody, itemKey, listItems } from "../src/aisearch.js";

export const CRAWL_CORPUS = "ircc";

export const TOPIC_MAP = {
  "canadian-citizenship": "citizenship",
  "immigrate-canada": "pr",
  "study-canada": "study",
  "work-canada": "work",
  "visit-canada": "visit",
  refugees: "refugees",
  "canadian-passports": "passports",
};

export function topicFor(url) {
  const match = url.match(/\/services\/([^/]+)/);
  const segment = match?.[1];
  return TOPIC_MAP[segment] ?? "other";
}

export function titleFor(item, markdown) {
  return (
    item["metadata.title"] ??
    item.metadata?.title ??
    markdown.match(/^#\s+(.+)$/m)?.[1] ??
    ""
  );
}

/**
 * The upload for one crawled page `{url, markdown}`, or null when the page is
 * too short to be worth indexing (same 100-char cut the chunked ingest used).
 */
export function pageItem(item, tagPrefix) {
  const markdown = item.markdown ?? "";
  if (!item.url || markdown.trim().length < 100) return null;
  const title = titleFor(item, markdown);
  return {
    key: itemKey(CRAWL_CORPUS, item.url),
    body: itemBody({ title, url: item.url, text: markdown }),
    metadata: {
      corpus: CRAWL_CORPUS,
      source: `${tagPrefix}-${topicFor(item.url)}`,
      url: item.url,
      title,
    },
  };
}

// Refuse a cleanup that would remove more than half the crawl corpus: a crawl
// that came back that small is far likelier broken than the site that small.
const MIN_KEPT_FRACTION = 0.5;

/**
 * Decide which listed items a finished crawl no longer covers. PURE — the
 * deletion itself is `deleteStale` below. Returns `{ stale, skipped, refusal }`.
 *
 * Fail-closed on every axis:
 *   - only keys under `ircc/` (so `ircc-live/` write-backs, and every other
 *     corpus sharing the instance, can never match);
 *   - only items whose own metadata says they came from THIS tag prefix;
 *     an item still queued for indexing has null metadata and is skipped;
 *   - nothing at all when any upload failed, or the crawl is implausibly small.
 */
export function planStale(listed, keptKeys, { tagPrefix, failedUploads = 0 }) {
  const prefix = `${CRAWL_CORPUS}/`;
  const kept = new Set(keptKeys);
  const crawlItems = [];
  const skipped = [];

  for (const it of listed) {
    if (typeof it?.id !== "string" || typeof it?.key !== "string") {
      return { stale: [], skipped, refusal: "an item in the list has no string id/key — unexpected shape" };
    }
    if (!it.key.startsWith(prefix)) continue;
    const source = it.metadata?.source;
    if (typeof source !== "string") {
      skipped.push(it.key);
      continue;
    }
    if (!source.startsWith(`${tagPrefix}-`)) continue;
    crawlItems.push(it);
  }

  if (failedUploads > 0) {
    return { stale: [], skipped, refusal: `${failedUploads} upload(s) failed` };
  }
  if (crawlItems.length > 0 && kept.size < crawlItems.length * MIN_KEPT_FRACTION) {
    return {
      stale: [],
      skipped,
      refusal: `the crawl kept ${kept.size} page(s) against ${crawlItems.length} existing item(s)`,
    };
  }
  return { stale: crawlItems.filter((it) => !kept.has(it.key)), skipped, refusal: null };
}

/** List `ircc/` items, plan with `planStale`, delete what it allows. */
export async function deleteStale(keptKeys, { tagPrefix, failedUploads = 0, log = console.log }) {
  const listed = await listItems({ search: `${CRAWL_CORPUS}/` });
  const { stale, skipped, refusal } = planStale(listed, keptKeys, { tagPrefix, failedUploads });
  if (skipped.length > 0) {
    log(`Stale cleanup: ${skipped.length} item(s) have no metadata yet (still indexing) — left alone.`);
  }
  if (refusal) {
    log(`Stale cleanup SKIPPED: ${refusal}. Nothing deleted.`);
    return { deleted: 0, refused: refusal };
  }
  for (const it of stale) await deleteItem(it.id);
  log(`Stale cleanup: deleted ${stale.length} item(s) the new crawl no longer contains.`);
  return { deleted: stale.length, refused: null };
}
