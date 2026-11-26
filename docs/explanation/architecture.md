# How it works

## Retrieval

`src/db.js` searches one private [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/)
instance (`src/aisearch.js`, plain `fetch` against its REST API) for the IRCC page chunks
closest to the question. The instance chunks and embeds every page itself and ranks hybrid
(vector + keyword).

- **The question leaves the machine at this step.** It goes to Cloudflare, which embeds it
  server-side.
- **The instance is shared with other corpora.** Every search is scoped to the `ircc` and
  `ircc-live` corpora twice: by an API filter, and again on each returned chunk's own metadata.
- Retrieval used to be a local pgvector + Ollama store. It moved to AI Search on 2026-11-19, so
  the same corpus serves every client, not only the machine running Postgres.

## Web fallback (CRAG)

`src/websearch.js` implements a simplified
[Corrective RAG](https://docs.langchain.com/oss/python/langgraph/agentic-rag) pattern.

- **Grading:** `graph.js`'s `answerFreeform()` grades retrieval by the best vector (cosine)
  similarity among the returned chunks, against `GRADE_THRESHOLD` in `src/graph.js`. That is
  stricter than `db.js`'s own noise filter, `SIMILARITY_FLOOR` in `src/db.js`. Both were measured
  on AI Search's embedding model, and `scripts/threshold-probe.mjs` re-runs the measurement.
- **The instance's top-level `score` is never graded on.** It is a fused hybrid rank, not a
  similarity.
- **Below the threshold, results are discarded, not blended,** in favour of a live
  `site:canada.ca` search through [Serper.dev](https://serper.dev). The fallback is always
  another official source, never the open web or the model's trained knowledge. The system
  prompt in `llm.js` forbids that regardless.
- **Self-learning:** each page a successful fallback fetched is uploaded to AI Search as one
  item (corpus and source `ircc-live`, keyed by its URL, so a re-fetch overwrites it). A
  similar later question is then answered from retrieval. Keyword search sees a new item at
  once. Vector search sees it only once indexing finishes, which takes minutes.
- **Without `SERPER_API_KEY`** the fallback silently does nothing, and the bot gives its
  existing "I don't have that info" answer.

## Synthesis

`src/llm.js` sends the retrieved chunks and the question to the OpenAI Responses API
(`client.responses.create`) and asks it to answer *only* from that content, with citations.
Replies are formatted for WhatsApp: short bullet points with emoji anchors, not paragraphs.
This step also leaves the machine.

**The model choice is deliberate.** The default is `MODEL` in `src/llm.js`, overridden by
`OPENAI_MODEL`. The `-pro` tier was the first pick for quality, but its replies take far longer.
W3C's COGA (Cognitive and Learning Disabilities Accessibility) guidance flags fatigue during
multi-step waits, and a long silence risks losing the reader regardless of how good the answer
is. So the default is the faster tier, and the `-pro` tier is one environment variable away.
`index.js` still sends an early "still working on it" message when a reply runs long, for
example on the web-fallback path.

## Dialogue

`src/graph.js` is an adaptive, branching intake: a short menu (visit, study, work, PR,
citizenship, something else), numbered quick replies where they help, and a graceful fallback.
A reply that does not match what was expected is treated as a real question and answered,
not rejected. The PR and citizenship branches collect a few basic facts (age, education,
language self-rating and so on). The LLM then compares that rough profile against the IRCC
eligibility criteria in the corpus, labelled as an informal, non-official read.

It is a [LangGraph.js](https://docs.langchain.com/oss/javascript/langgraph) `StateGraph`.

- **Each step is a node that pauses on `interrupt()`** until the next WhatsApp message.
- **State is checkpointed to Postgres** (`RAGDB_URI`, through
  `@langchain/langgraph-checkpoint-postgres`'s `PostgresSaver`), keyed by WhatsApp JID as the
  LangGraph `thread_id`. A conversation, even mid-intake, survives the process crashing or
  restarting. `src/simulate.js` verifies this by compiling a fresh graph mid-conversation.
- **Graph nodes must have no I/O side effects before their `interrupt()` call.** On resume,
  LangGraph re-runs a node from its top, so a side effect there would fire twice. Nodes only
  call `retrieve()` and `synthesize()` (safe to redo) and return data. Only `src/index.js` sends
  messages, based on the graph's output.

## Transport

`src/index.js` connects to WhatsApp through [Baileys](https://github.com/WhiskeySockets/Baileys),
an *unofficial* WhatsApp Web protocol client. See the README's pairing section for the risk.

## Why LangGraph, not a hand-rolled state machine

The dialogue engine was first a hand-rolled, JSON-file-backed state machine
(`dialogue.js`/`state.js`, now removed). It had a real bug: it cleared session state *before*
the slow LLM call finished, so a crash in that window lost the user's whole collected profile.

- **Rejected: a full workflow-engine migration** such as Temporal. It is more infrastructure
  than this project needs.
- **Chosen: LangGraph's checkpointing pattern.** It persists state at every step and resumes
  across restarts, which fixes exactly that bug. The dialogue engine runs on LangGraph.js with
  `PostgresSaver` against the Postgres that already ran locally, instead of reimplementing the
  pattern by hand.
