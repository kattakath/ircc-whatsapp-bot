// Offline dialogue harness (docs/conversation-design.md FIX-01). Hard rules from §7:
// - no network: globalThis.fetch throws on ANY host, so a missed stub fails loudly;
// - fake credentials only, so aisearch.js never reaches the login Keychain and llm.js
//   never needs a real key (the env var is checked before the Keychain);
// - retrieval, web fallback, persistence and the LLM are injected stubs (buildGraph(deps)),
//   so nothing is written to the shared AI Search instance;
// - checkpoints live in MemorySaver; Postgres only via scratchPgUri() (layer L4).
process.env.OPENAI_API_KEY = "test-not-a-key";
process.env.CLOUDFLARE_AI_SEARCH_TOKEN = "test-not-a-token";
process.env.CF_ACCOUNT_ID = "test-account";
process.env.SERPER_API_KEY = "test-not-a-key";
globalThis.fetch = async (url) => {
  throw new Error(`network is forbidden in the dialogue harness (tried ${url})`);
};

const { MemorySaver } = await import("@langchain/langgraph");
const { buildGraph } = await import("../../src/graph.js");
const { handleTurn } = await import("../../src/turn.js");

export const LIVE_DB_DEFAULT = "postgresql://mcp@127.0.0.1:5433/ragdb";

/** Stub dependencies that record every call. `answer` decides the LLM text. */
export function makeDeps({ answer = (q) => `Answer to: ${q}`, similarity = 0.9, chunks, web = [] } = {}) {
  const calls = { retrieve: [], synthesize: [], webFallback: [], persist: [] };
  const deps = {
    retrieve: async (question, opts) => {
      calls.retrieve.push({ question, opts });
      return (
        chunks ?? [{ content: "stub chunk", similarity, metadata: { url: "https://www.canada.ca/en/immigration-refugees-citizenship/services/stub.html", title: "Stub" } }]
      );
    },
    topSimilarity: (cs) => (cs.length ? Math.max(...cs.map((c) => c.similarity ?? 0)) : 0),
    synthesize: async (question, cs) => {
      calls.synthesize.push({ question, chunks: cs });
      return answer(question, cs);
    },
    webFallback: async (question) => {
      calls.webFallback.push(question);
      return web;
    },
    persistWebFallback: async (cs) => {
      calls.persist.push(cs);
    },
  };
  return { deps, calls };
}

/**
 * A harness around one chat: a real compiled graph (MemorySaver) + handleTurn with
 * recording send/presence. `turn(text)` runs one inbound message and returns the
 * outbound events it produced (the per-message outbound budget, §4).
 */
export function makeHarness(depOpts = {}, { jid = "15550000001@s.whatsapp.net", now } = {}) {
  const { deps, calls } = makeDeps(depOpts);
  const graph = buildGraph(deps).compile({ checkpointer: new MemorySaver() });
  const outbox = [];
  const quiet = { log: () => {}, error: () => {} };
  const send = async (to, content) => {
    outbox.push({ kind: "send", to, text: content.text });
  };
  const presence = async (state, to) => {
    outbox.push({ kind: "presence", to, state });
  };
  async function turn(text) {
    const before = outbox.length;
    const result = await handleTurn({ jid, text, graph, send, presence, logger: quiet, ...(now ? { now } : {}) });
    const events = outbox.slice(before);
    return { ...result, events, sends: events.filter((e) => e.kind === "send").map((e) => e.text) };
  }
  return { graph, calls, outbox, turn, jid };
}

/** Layer L4: the ONLY way a test may reach Postgres. Refuses the live checkpoint DB. */
export function scratchPgUri(env = process.env) {
  const uri = env.IRCC_TEST_PG_URI;
  if (!uri) throw new Error("IRCC_TEST_PG_URI is not set: L4 persistence tests need a scratch Postgres");
  if (uri === env.RAGDB_URI || uri === LIVE_DB_DEFAULT) {
    throw new Error("IRCC_TEST_PG_URI points at the live checkpoint database (RAGDB_URI or its default): refusing");
  }
  return uri;
}
