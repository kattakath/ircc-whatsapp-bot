# Refresh the IRCC corpus

## What is in it

Official canada.ca IRCC pages, one AI Search item per page in corpus `ircc` (the instance chunks
and embeds them), plus the CRAG write-backs in corpus `ircc-live`.

- **The crawl:** the Apify `apify/website-content-crawler` actor, started from the IRCC
  `/services/` hub pages and scoped to `.../services/**` plus a few pinned pages outside it. It
  is deliberately bounded, not the whole canada.ca domain, so press releases and corporate
  content do not dilute retrieval. The start URLs, globs, depth and page cap are the actor
  input in [`scripts/recrawl.js`](../../scripts/recrawl.js).
- **Item keys:** `itemKey` in `src/aisearch.js` derives each key from the page URL, so
  re-ingesting a page overwrites its item instead of adding a duplicate. `npm test` pins the
  format.
- **Topic tags:** each page gets a per-topic `source` (`ircc-crawl-<topic>`) from its URL path,
  through `TOPIC_MAP` in `scripts/crawl-pages.js`. `graph.js`'s `TOPIC_BRANCHES` and
  `BRANCH_SOURCES` filter retrieval by those exact tags. **If you change the crawl, keep the
  two in sync**, or a menu branch silently returns no results.

**This content goes stale.** The first crawl already picked up a December 2025 legal change
(Bill C-3) and 2026 travel restrictions. Without a refresh, an answer that is right today can
quietly go wrong.

## Re-crawl by hand

```sh
node scripts/recrawl.js
```

It needs `APIFY_TOKEN` and `CF_ACCOUNT_ID` in `.env`, and the AI Search token (environment or
Keychain: see [configuration](../reference/configuration.md#secrets)).

1. It starts the Apify actor through its REST API, waits for it, and downloads the dataset.
2. It runs the pages through `ingest-crawl.js`. Every page is an upsert, so a re-run is safe.
3. Once **every** upload has succeeded, it deletes the `ircc/` items the new crawl no longer
   contains.

It refuses to delete anything if an upload failed, if the crawl came back implausibly small,
or if an item has no metadata yet (still indexing). It never deletes `ircc-live` items.

## Re-crawl monthly with launchd

```sh
cp scripts/com.ismailkattakath.ircc-whatsapp-bot.recrawl.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ismailkattakath.ircc-whatsapp-bot.recrawl.plist
```

The plist's `StartCalendarInterval` sets the schedule. It logs to
`~/Library/Logs/ircc-whatsapp-bot-recrawl.log`. It is a plain `launchd` plist, not wired into
Home Manager, so it is easy to inspect or remove (`launchctl unload …`, then delete the file).

## Durable re-crawl with Inngest

`scripts/inngest/` runs the same logic (shared through `scripts/crawl-pages.js`), but each page
is its own retried [Inngest](https://www.inngest.com) step. The stale-item cleanup is a last
step that runs only after every page step succeeded.

- A crash mid-run resumes without redoing finished pages.
- A step killed mid-page re-runs. The page is one upsert keyed by its URL, so the retry
  overwrites the same item.

Use it for a large or flaky re-crawl. For the normal case it is overkill.

```sh
npm run inngest:serve        # terminal 1
inngest dev                  # terminal 2 (local Dev Server, UI on :8288)
node scripts/inngest/trigger-ingest.js <dataset.json> ircc-crawl   # terminal 3
```
