// Cloudflare AI Search client — the RAG store since 2026-11-19, replacing the
// local pgvector `ragdb` corpus. One private instance holds the corpus; it
// chunks and embeds each uploaded item itself, so this file only uploads whole
// pages and runs searches. Plain `fetch`, no SDK: four REST calls do not earn a
// dependency (and a lockfile change would move nix/package.nix's npmDepsHash).
//
// Config is resolved LAZILY, on the first API call, so importing this module
// (or db.js) needs no token — the offline test suite depends on that.
//
//   CF_ACCOUNT_ID               required. Not a secret, but per-operator, so it
//                               lives in env / .env / the Nix module option,
//                               never in the repo.
//   CLOUDFLARE_AI_SEARCH_TOKEN  the API token. Unset on macOS → read from the
//                               login Keychain, service `cf:cloudflare.com:ai-search`,
//                               account = the login user (the same lookup
//                               nix/module.nix does for the other keys). The
//                               lookup lives HERE rather than in that runner so
//                               every entry point gets it: the bot, the recrawl
//                               launchd job, ingest-crawl.js, test-pipeline.js.
//   CF_AI_SEARCH_INSTANCE       optional, default `rag`.
//
// The token is only ever moved into an Authorization header — never logged.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";

export const KEYCHAIN_SERVICE = "cf:cloudflare.com:ai-search";
const API_ROOT = "https://api.cloudflare.com/client/v4/accounts";

let cached = null;

function keychainToken() {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-a", os.userInfo().username, "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    return "";
  }
}

function config() {
  if (cached) return cached;
  const accountId = (process.env.CF_ACCOUNT_ID ?? "").trim();
  if (!accountId) {
    throw new Error("CF_ACCOUNT_ID is not set — the Cloudflare account that holds the AI Search instance.");
  }
  const token = (process.env.CLOUDFLARE_AI_SEARCH_TOKEN ?? "").trim() || keychainToken();
  if (!token) {
    throw new Error(
      `No AI Search token: set CLOUDFLARE_AI_SEARCH_TOKEN, or on macOS store it in the login Keychain as ${KEYCHAIN_SERVICE}.`
    );
  }
  const instance = (process.env.CF_AI_SEARCH_INSTANCE ?? "").trim() || "rag";
  cached = {
    base: `${API_ROOT}/${accountId}/ai-search/namespaces/default/instances/${encodeURIComponent(instance)}`,
    headers: { Authorization: `Bearer ${token}` },
  };
  return cached;
}

/** Test hook: forget the resolved config so a test can change the env. */
export function resetConfig() {
  cached = null;
}

async function call(path, init = {}) {
  const { base, headers } = config();
  // Per-call deadline (FIX-03); a caller-supplied signal wins.
  const signal = init.signal ?? AbortSignal.timeout(20_000);
  const res = await fetch(`${base}${path}`, { ...init, signal, headers: { ...headers, ...init.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.success === false) {
    const errors = JSON.stringify(body?.errors ?? body ?? null);
    throw new Error(`AI Search ${init.method ?? "GET"} ${path} failed: ${res.status} ${errors}`);
  }
  return body;
}

// ---- item keys --------------------------------------------------------------
//
// MUST match the operator's export byte for byte, or a re-crawl duplicates every
// page instead of overwriting it. Ported from the export's Python:
//
//   def slug(s, n):
//       s = re.sub(r"^https?://", "", s)
//       s = re.sub(r"[^A-Za-z0-9._/-]+", "-", s).strip("-/")
//       s = s.replace("/", "_")
//       return s[:n].strip("-_.") or "doc"
//   def item_key(corpus, ident):
//       h = hashlib.sha1(ident.encode()).hexdigest()[:10]
//       base = f"{corpus}/"
//       room = 128 - len(base) - len(h) - len("-.md")
//       return f"{base}{slug(ident, room)}-{h}.md"
//
// Python's `.strip(chars)` strips those chars from BOTH ends, hence the paired
// anchors below. `s[:n]` slices by code point and `.slice` by UTF-16 code unit;
// they agree here because the second substitution leaves only ASCII. The sha1
// input is UTF-8 in both (`str.encode()` and Node's string default).

const MAX_KEY = 128;

function slug(s, n) {
  let out = s.replace(/^https?:\/\//, "");
  out = out.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^[-/]+|[-/]+$/g, "");
  out = out.replaceAll("/", "_");
  return out.slice(0, n).replace(/^[-_.]+|[-_.]+$/g, "") || "doc";
}

export function itemKey(corpus, ident) {
  const h = createHash("sha1").update(ident).digest("hex").slice(0, 10);
  const base = `${corpus}/`;
  const room = MAX_KEY - base.length - h.length - "-.md".length;
  return `${base}${slug(ident, room)}-${h}.md`;
}

/** The file body the export used: one markdown file per page. */
export function itemBody({ title, url, text }) {
  return `# ${title ?? ""}\n\nSource: ${url ?? "unknown"}\n\n${text}\n`;
}

export function contentHash(text) {
  return createHash("sha1").update(text).digest("hex");
}

// ---- API calls --------------------------------------------------------------

/**
 * Upload (or overwrite — re-uploading a key returns the same item id) one item.
 * `metadata` holds only the instance's custom fields: corpus, source, url, repo,
 * title. Vector search sees a new item only after indexing (minutes); keyword
 * search sees it at once.
 */
export async function upsertItem({ key, body, metadata }) {
  const form = new FormData();
  form.append("file", new Blob([body], { type: "text/markdown" }), key);
  form.append("metadata", JSON.stringify(metadata));
  const res = await call("/items", { method: "POST", body: form });
  return res.result;
}

/**
 * Every item whose key matches `search` (the list endpoint's own substring
 * filter), across all pages. The endpoint caps `per_page` at 50 (measured: 51+
 * is a 400). Throws rather than return a partial list: a caller deciding what to
 * DELETE must never act on one.
 */
export async function listItems({ search } = {}) {
  const perPage = 50;
  const out = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (search) q.set("search", search);
    const res = await call(`/items?${q}`);
    const batch = res.result;
    const total = res.result_info?.total_count;
    if (!Array.isArray(batch) || !Number.isInteger(total)) {
      throw new Error("AI Search items list: unexpected response shape (no result array / total_count).");
    }
    out.push(...batch);
    if (batch.length === 0 || out.length >= total) {
      if (out.length !== total) {
        throw new Error(`AI Search items list: collected ${out.length} items but total_count is ${total}.`);
      }
      return out;
    }
  }
}

export async function deleteItem(id) {
  await call(`/items/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Raw search: returns the API's `result.chunks` array, each
 * `{ text, score, item: { key, metadata }, scoring_details }`.
 */
export async function searchChunks(query, { maxResults, matchThreshold, filters } = {}) {
  const retrieval = {};
  if (maxResults != null) retrieval.max_num_results = maxResults;
  if (matchThreshold != null) retrieval.match_threshold = matchThreshold;
  if (filters) retrieval.filters = filters;
  const res = await call("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, ai_search_options: { retrieval } }),
  });
  return res.result?.chunks ?? [];
}
