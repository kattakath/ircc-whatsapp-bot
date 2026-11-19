// Full unattended re-crawl pipeline: trigger the Apify website-content-crawler
// actor via its REST API (no interactive MCP tools needed — this runs
// standalone, e.g. from a monthly launchd job), poll for completion,
// download the dataset, and run it through ingest-crawl.js.
//
// Requires APIFY_TOKEN in the environment (already registered via
// `secret set APIFY_TOKEN` in this setup) plus everything ingest-crawl.js
// needs: CF_ACCOUNT_ID, and the AI Search token (CLOUDFLARE_AI_SEARCH_TOKEN,
// or on macOS the login-Keychain item src/aisearch.js falls back to).
//
// Usage: node scripts/recrawl.js
import "dotenv/config";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APIFY_TOKEN = process.env.APIFY_TOKEN;
if (!APIFY_TOKEN) {
  console.error("APIFY_TOKEN not set — cannot trigger a crawl.");
  process.exit(1);
}

const ACTOR = "apify~website-content-crawler";
const START_URLS = [
  "https://www.canada.ca/en/immigration-refugees-citizenship/services/canadian-citizenship.html",
  "https://www.canada.ca/en/immigration-refugees-citizenship/services/immigrate-canada.html",
  "https://www.canada.ca/en/immigration-refugees-citizenship/services/study-canada.html",
  "https://www.canada.ca/en/immigration-refugees-citizenship/services/work-canada.html",
  "https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada.html",
].map((url) => ({ url }));

const INPUT = {
  startUrls: START_URLS,
  crawlerType: "playwright:adaptive",
  includeUrlGlobs: [{ glob: "https://www.canada.ca/en/immigration-refugees-citizenship/services/**" }],
  excludeUrlGlobs: [{ glob: "https://www.canada.ca/en/immigration-refugees-citizenship/services/reference-include/**" }],
  maxCrawlDepth: 3,
  maxCrawlPages: 300,
  maxResults: 300,
  respectRobotsTxtFile: true,
  saveMarkdown: true,
  htmlTransformer: "readableText",
  proxyConfiguration: { useApifyProxy: true },
};

async function apify(pathSuffix, options = {}) {
  const url = `https://api.apify.com/v2/${pathSuffix}${pathSuffix.includes("?") ? "&" : "?"}token=${APIFY_TOKEN}`;
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Apify API ${pathSuffix} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting monthly IRCC re-crawl...`);

  const runResp = await apify(`acts/${ACTOR}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(INPUT),
  });
  const runId = runResp.data.id;
  console.log(`Run started: ${runId}`);

  // Poll every 15s, up to 20 minutes — the interactive run earlier took ~4.5min.
  let run;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    run = (await apify(`actor-runs/${runId}`)).data;
    console.log(`  status: ${run.status} (${((Date.now() - new Date(run.startedAt)) / 1000).toFixed(0)}s elapsed)`);
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) break;
  }

  if (run.status !== "SUCCEEDED") {
    console.error(`Crawl did not succeed: ${run.status}. Aborting — not touching the existing AI Search items.`);
    process.exit(1);
  }

  console.log("Crawl succeeded. Downloading dataset...");
  const items = await apify(`datasets/${run.defaultDatasetId}/items?format=json&clean=true`);
  console.log(`Downloaded ${items.length} pages.`);

  const datasetPath = path.join(os.tmpdir(), `ircc-recrawl-${Date.now()}.json`);
  fs.writeFileSync(datasetPath, JSON.stringify(items));

  console.log("Running ingest-crawl.js...");
  execFileSync("node", [path.join(__dirname, "ingest-crawl.js"), datasetPath, "ircc-crawl"], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });

  fs.unlinkSync(datasetPath);
  console.log(`[${new Date().toISOString()}] Re-crawl complete.`);
}

main().catch((err) => {
  console.error("Re-crawl failed:", err);
  process.exit(1);
});
