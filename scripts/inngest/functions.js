import fs from "node:fs";
import { inngest } from "./client.js";
import { upsertItem } from "../../src/aisearch.js";
import { deleteStale, pageItem } from "../crawl-pages.js";

/**
 * Durable version of scripts/ingest-crawl.js. Each page is its own
 * `step.run` — Inngest memoizes completed steps, so if the run crashes or
 * is retried partway through a 300-page dataset, already-uploaded pages
 * are NOT redone; only the page that failed (and anything after it)
 * re-runs.
 *
 * step.run only memoizes on successful completion — a step killed
 * mid-execution is NOT memoized and retries from its own top. That used to
 * need a per-page DB transaction (a half-inserted page plus a full redo left
 * duplicate rows). It no longer does: a page is now ONE upsert keyed by its
 * URL, so a retried step overwrites the same item instead of adding one.
 *
 * The stale cleanup runs last, as its own step, and only after every page
 * step has succeeded (a step that exhausts its retries fails the whole run
 * first), with the same fail-closed rules as the CLI (crawl-pages.js).
 *
 * Trigger: send event "crawl/ingest.requested" with
 *   { datasetPath: "/abs/path/to/dataset.json", tagPrefix: "ircc-crawl" }
 */
export const ingestCrawlDataset = inngest.createFunction(
  { id: "ingest-crawl-dataset", retries: 3, triggers: { event: "crawl/ingest.requested" } },
  async ({ event, step }) => {
    const { datasetPath, tagPrefix } = event.data;

    const items = await step.run("load-dataset", async () => {
      const raw = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
      return Array.isArray(raw) ? raw : raw.items;
    });

    const kept = [];
    let skippedPages = 0;

    for (let p = 0; p < items.length; p++) {
      const item = items[p];
      const result = await step.run(`ingest-page-${p}`, async () => {
        const upload = pageItem(item, tagPrefix);
        if (!upload) return { skipped: true, key: null };
        await upsertItem(upload);
        return { skipped: false, key: upload.key };
      });

      if (result.skipped) skippedPages++;
      else kept.push(result.key);
    }

    const cleanup = await step.run("delete-stale-items", () => deleteStale(kept, { tagPrefix }));

    return { totalPages: items.length, uploaded: kept.length, skippedPages, ...cleanup };
  }
);
