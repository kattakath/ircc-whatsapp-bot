import pg from "pg";
import { buildRetrieveQuery } from "./retrieval-query.js";

// Loopback-only, trust-auth role scoped to ragdb — see
// https://github.com/kattakath/nix-local-rag (modules/pgvector-local.nix).
// Not a secret: no password exists for this role, and it only accepts
// connections from 127.0.0.1.
const DATABASE_URI =
  process.env.RAGDB_URI ?? "postgresql://mcp@127.0.0.1:5433/ragdb";

const pool = new pg.Pool({ connectionString: DATABASE_URI });

const SIMILARITY_FLOOR = 0.3;

/**
 * Retrieve the top-k IRCC chunks for a question, optionally narrowed to one
 * or more `source` values (e.g. ["ircc-crawl-pr"]). The shared docs table may
 * contain private or unrelated corpora, so unscoped retrieval is IRCC-only.
 * Returns [] if nothing clears SIMILARITY_FLOOR.
 */
export async function retrieve(question, { sources = null, limit = 8 } = {}) {
  const query = buildRetrieveQuery(question, { sources, limit });
  const { rows } = await pool.query(query.sql, query.params);
  return rows.filter((r) => r.similarity >= SIMILARITY_FLOOR);
}

/**
 * Inserts one chunk directly (embedding computed in-DB via embed()) — used
 * by the CRAG web-fallback path to persist freshly fetched content, so a
 * repeat of a similar question hits local retrieval next time instead of
 * triggering another live search.
 */
export async function persistChunk(content, metadata) {
  await pool.query(
    "INSERT INTO docs (content, metadata, embedding) VALUES ($1, $2::jsonb, embed($1))",
    [content, JSON.stringify(metadata)]
  );
}

export async function closeDb() {
  await pool.end();
}
