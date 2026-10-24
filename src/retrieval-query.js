/** Build the parameterized retrieval query, scoped to IRCC unless overridden. */
export function buildRetrieveQuery(question, { sources = null, limit = 8 } = {}) {
  const params = [question];
  let sourceFilter;

  if (sources && sources.length > 0) {
    params.push(sources);
    sourceFilter = `WHERE metadata->>'source' = ANY($${params.length}::text[])`;
  } else {
    sourceFilter = "WHERE metadata->>'source' LIKE 'ircc-%'";
  }

  params.push(limit);

  return {
    sql: `
    SELECT content,
           metadata,
           1 - (embedding <=> embed($1)) AS similarity
    FROM docs
    ${sourceFilter}
    ORDER BY embedding <=> embed($1)
    LIMIT $${params.length}
  `,
    params,
  };
}
