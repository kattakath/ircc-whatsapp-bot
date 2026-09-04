import pg from "pg";

// Loopback-only, trust-auth role scoped to ragdb — see
// ~/Developer/github.com/kattakath/nix-local-rag/modules/pgvector-local.nix.
// Not a secret: no password exists for this role, and it only accepts
// connections from 127.0.0.1.
const DATABASE_URI =
  process.env.RAGDB_URI ?? "postgresql://mcp@127.0.0.1:5433/ragdb";

const pool = new pg.Pool({ connectionString: DATABASE_URI });

const SIMILARITY_FLOOR = 0.3;

/**
 * Retrieve the top-k IRCC chunks for a question, optionally scoped to one
 * or more `source` values (e.g. ["ircc-pr", "ircc-citizenship"]).
 * Returns [] if nothing clears SIMILARITY_FLOOR.
 */
export async function retrieve(question, { sources = null, limit = 8 } = {}) {
  const params = [question];
  let sourceFilter = "";
  if (sources && sources.length > 0) {
    params.push(sources);
    sourceFilter = `WHERE metadata->>'source' = ANY($${params.length}::text[])`;
  }
  params.push(limit);

  const sql = `
    SELECT content,
           metadata,
           1 - (embedding <=> embed($1)) AS similarity
    FROM docs
    ${sourceFilter}
    ORDER BY embedding <=> embed($1)
    LIMIT $${params.length}
  `;

  const { rows } = await pool.query(sql, params);
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
