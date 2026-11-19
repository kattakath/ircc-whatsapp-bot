// Ingests an apify/website-content-crawler dataset export (JSON array of
// {url, markdown}) into the Cloudflare AI Search store: ONE item per page,
// keyed by its URL (scripts/crawl-pages.js), which the store chunks and embeds
// itself. Each page is tagged with a per-topic source (derived from its URL path
// under /services/), not one flat tag — graph.js's PR/citizenship/topic branches
// filter retrieval by these exact source tags, so a single flat tag would make
// that scoping impossible.
//
// Re-runnable: every page is an upsert, so a re-crawl overwrites in place. After
// all uploads succeed, items under `ircc/` from this tag prefix that the new
// crawl no longer contains are deleted (crawl-pages.js `planStale` says when it
// refuses). `ircc-live` CRAG write-backs are never touched.
//
// Usage: node scripts/ingest-crawl.js <path-to-dataset.json> <tag-prefix>
// For a durable, resumable version (retries per page, survives a crash midway
// through a large dataset without redoing already-uploaded pages), see
// scripts/inngest/ — same logic, shared via scripts/crawl-pages.js.
import "dotenv/config";
import fs from "node:fs";
import { upsertItem } from "../src/aisearch.js";
import { deleteStale, pageItem } from "./crawl-pages.js";

const [, , datasetPath, tagPrefix] = process.argv;
if (!datasetPath || !tagPrefix) {
  console.error("Usage: node scripts/ingest-crawl.js <dataset.json> <tag-prefix>");
  process.exit(1);
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const items = Array.isArray(raw) ? raw : raw.items;
  console.log(`Loaded ${items.length} pages from ${datasetPath}`);

  const kept = [];
  let skippedPages = 0;
  let failed = 0;
  const startTime = Date.now();

  for (let p = 0; p < items.length; p++) {
    const upload = pageItem(items[p], tagPrefix);
    if (!upload) {
      skippedPages++;
      continue;
    }
    try {
      await upsertItem(upload);
      kept.push(upload.key);
    } catch (err) {
      failed++;
      console.error(`Upload failed for ${items[p].url}:`, err.message);
    }

    if ((p + 1) % 20 === 0 || p === items.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`[${p + 1}/${items.length} pages] ${kept.length} uploaded so far (${elapsed}s elapsed)`);
    }
  }

  console.log(`Uploaded ${kept.length} pages, ${skippedPages} skipped (too short), ${failed} failed.`);
  await deleteStale(kept, { tagPrefix, failedUploads: failed });
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
