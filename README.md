# ircc-whatsapp-bot

[![CI](https://github.com/kattakath/ircc-whatsapp-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/kattakath/ircc-whatsapp-bot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Built with Nix](https://img.shields.io/badge/built%20with-Nix-5277C3.svg?logo=nixos&logoColor=white)](https://nixos.org)
[![LangGraph.js](https://img.shields.io/badge/dialogue-LangGraph.js-1C3C3C.svg)](https://docs.langchain.com/oss/javascript/langgraph)

A WhatsApp bot that answers Canadian immigration questions grounded in
official IRCC (canada.ca) pages, via a Cloudflare AI Search RAG store. Built to
informally help a friend explore her options — not a licensed immigration
consulting tool. See "Legal boundary" below.

```mermaid
flowchart LR
    WA["WhatsApp\n(Baileys)"] <--> IDX["index.js\ntransport + allowlist"]
    IDX <--> GRAPH["graph.js\nLangGraph.js dialogue"]
    CKPT[("Postgres\ncheckpointer")] <--> GRAPH
    GRAPH --> DB[("Cloudflare AI Search\nhybrid vector + keyword")]
    DB -. "similarity < 0.6" .-> WEB["websearch.js\nCRAG: Serper, site:canada.ca"]
    WEB -. "persist\nfor next time" .-> DB
    GRAPH --> LLM["llm.js\nOpenAI synthesis"]
    LLM --> GRAPH
```

## How it works

- **Retrieval**: `src/db.js` searches one private
  [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/)
  instance (`src/aisearch.js`, plain `fetch` against its REST API) for the
  IRCC page chunks closest to the question. The instance chunks and embeds
  every page itself and ranks hybrid (vector + keyword). **The question
  leaves the machine at this step**: it goes to Cloudflare, which embeds it
  server-side. The instance is shared with other corpora, so every search is
  scoped to the `ircc` and `ircc-live` corpora — by an API filter *and*
  again on each returned chunk's own metadata. Retrieval moved here from a
  local pgvector + Ollama store on 2026-11-19, so the same corpus serves
  every client, not only the machine running Postgres.
- **Web fallback (CRAG)**: `src/websearch.js` implements a simplified
  [Corrective RAG](https://docs.langchain.com/oss/python/langgraph/agentic-rag)
  pattern — `graph.js`'s `answerFreeform()` grades retrieval by the best
  vector (cosine) similarity among the returned chunks (`GRADE_THRESHOLD =
  0.6`, stricter than `db.js`'s own noise-filtering `SIMILARITY_FLOOR = 0.45`;
  both measured on AI Search's embedding model with
  `scripts/threshold-probe.mjs`, which re-runs the measurement). The instance's top-level `score` is a fused hybrid rank,
  not a similarity, so it is never graded on. Below the threshold, results are
  **discarded** (not blended) in favor of a live, `site:canada.ca`-scoped
  search via [Serper.dev](https://serper.dev). This exists specifically to
  avoid the LLM falling back to ungrounded parametric knowledge when local
  retrieval is weak — the fallback is always another official source, never
  open-web or the model's own trained knowledge (the system prompt in
  `llm.js` forbids that regardless). Self-learning: each page a successful
  web fallback fetched is uploaded to AI Search as one item (corpus and
  source `ircc-live`, keyed by its URL, so a re-fetch overwrites it), and a
  similar future question is answered from retrieval instead of triggering
  another live search. Vector search sees a new item only once indexing
  finishes (minutes); keyword search sees it at once. Requires `SERPER_API_KEY`; without it, web
  fallback silently no-ops and the existing "I don't have that info" answer
  is used instead.
- **Synthesis**: `src/llm.js` sends the retrieved chunks + question to the
  OpenAI API (`gpt-5.5`, a few seconds per reply — via the Responses API,
  `client.responses.create`, which also works for the "-pro" tier if you
  ever want to swap back up) and asks it to answer *only* from that
  content, formatted for WhatsApp (short bullet points with emoji anchors,
  not prose paragraphs — the established chatbot/conversational-UI writing
  pattern), with citations. This step does leave the machine (OpenAI API).

  **Model choice is deliberate, not a default**: `gpt-5.5-pro` (30-90s per
  reply) was the original pick for "highest intelligence," but the system
  audit found this in direct tension with the actual audience — W3C's COGA
  cognitive-accessibility guidelines specifically flag fatigue during
  multi-step waits, and a 30-90s silence risks losing her attention
  entirely regardless of how good the eventual answer is. Switched to the
  faster tier after weighing that tradeoff explicitly. `index.js` still
  sends an early "still working on it" filler for the cases that do run
  long (e.g. the CRAG web-fallback path doing a live search + fetch on top
  of the LLM call), so the mitigation stays as a safety net either way.
- **Dialogue**: `src/graph.js` is an adaptive, branching intake — a short
  menu (visit / study / work / PR / citizenship / something else), numbered
  quick-reply options instead of free typing where it matters, and a
  graceful fallback: if a reply doesn't match what's expected, it's treated
  as a real question and answered directly rather than rejected as invalid
  input. For the PR and citizenship branches, it collects a few basic facts
  (age, education, language self-rating, etc.) and asks the LLM to compare
  that rough profile against the real IRCC eligibility criteria already in
  the RAG store — clearly labeled as an informal, non-official read.

  This is built as a [LangGraph.js](https://docs.langchain.com/oss/javascript/langgraph)
  `StateGraph`, not a hand-rolled state machine — each menu/prompt step is a
  node that pauses on `interrupt()` waiting for the next WhatsApp message,
  and conversation state is checkpointed to a local Postgres (`RAGDB_URI`,
  via `@langchain/langgraph-checkpoint-postgres`'s `PostgresSaver`), keyed by
  WhatsApp JID as the LangGraph `thread_id`. This means a conversation
  (including mid-intake, e.g. she's answered 3 of 6 PR questions) survives
  the bot process crashing or restarting — verified in
  `src/simulate.js` by compiling a fresh graph instance mid-conversation
  and confirming it resumes correctly from the last checkpoint.

  **Important constraint this depends on**: graph nodes must have no I/O
  side effects (no sending WhatsApp messages) before their `interrupt()`
  call — on resume-after-crash, LangGraph re-executes a node from its top,
  so a side effect there would double-fire. Nodes only call
  `retrieve()`/`synthesize()` (safe to redo) and return data; `src/index.js`
  is solely responsible for actually sending messages, based on the graph's
  output.
- **Transport**: `src/index.js` connects to WhatsApp via
  [Baileys](https://github.com/WhiskeySockets/Baileys), an *unofficial*
  WhatsApp Web protocol client (see risk note below).

## Why LangGraph, not a hand-rolled state machine

The dialogue engine originally was a hand-rolled JSON-file-backed state
machine (`dialogue.js`/`state.js`, now removed). It had a real bug: session
state got cleared *before* the slow LLM synthesis call completed, so a
process crash during that ~30-90s window silently lost a user's entire
collected profile (age, education, etc.) with no recovery. Research into
whether this was reinventing an already-solved problem found: full
migration to a framework (LangGraph, Temporal) is more infrastructure than
a single-friend prototype needs, but LangGraph's checkpointing *pattern* —
persist state at every step, resumable across process restarts — directly
solves this exact bug. Since this was worth doing regardless of scale, the
whole dialogue engine now runs on LangGraph.js with `PostgresSaver`
checkpointing against the already-running local Postgres (`RAGDB_URI` —
the one that also held the retrieval corpus until it moved to AI Search),
rather than reimplementing that pattern by hand.

## Setup

```sh
npm install
```

Environment variables:
- `OPENAI_API_KEY` — required.
- `OPENAI_MODEL` — optional, defaults to `gpt-5.5` (a few seconds per
  reply). Set to `gpt-5.5-pro` for deeper reasoning at the cost of 30-90s
  per reply — no code change needed either way, `client.responses.create`
  works for both tiers.
- `CF_ACCOUNT_ID` — required: the Cloudflare account holding the AI Search
  instance. Not a secret, but per-operator, so it never lives in this repo.
- `CLOUDFLARE_AI_SEARCH_TOKEN` — required: an API token with AI Search
  access. On macOS you can leave it unset and store it in the login Keychain
  instead (`secret set cf:cloudflare.com:ai-search`, or any generic-password
  item with that service name and your login user as the account):
  `src/aisearch.js` reads it from there, for the bot and the re-crawl/ingest
  scripts alike. The token is never logged.
- `CF_AI_SEARCH_INSTANCE` — optional, defaults to `rag`.
- `RAGDB_URI` — optional, defaults to `postgresql://mcp@127.0.0.1:5433/ragdb`.
  Used only by the LangGraph checkpointer now.
- `SERPER_API_KEY` — optional but needed for CRAG web fallback (see above);
  free tier at [serper.dev](https://serper.dev). Without it, weak local
  retrieval just falls through to the existing "I don't have that info"
  answer instead of searching canada.ca live.
- `PAIR_PHONE_NUMBER` — optional: digits only, no `+`. Set it to pair via a
  phone-number code instead of scanning a QR (see "Pairing WhatsApp" below).
- `ALLOWED_NUMBERS` — optional but recommended once this is live: a
  comma-separated allowlist of phone numbers (digits only, e.g.
  `15145551234`) permitted to talk to the bot. Unset = replies to anyone
  who messages the linked number.
- `LANGCHAIN_TRACING_V2` / `LANGCHAIN_API_KEY` / `LANGCHAIN_PROJECT` —
  optional LangSmith tracing; tracing is off unless `LANGCHAIN_TRACING_V2`
  is `true`.
- `APIFY_TOKEN` — only for re-crawl/ingest (`scripts/recrawl.js`); not
  needed to run the bot.
- `INNGEST_SERVE_PORT` — only for `scripts/inngest/serve.js`.

`.env.example` is the authoritative list — copy it to `.env` and fill in.

## Pairing WhatsApp — use a SPARE number, not your friend's main one

Baileys links to a real WhatsApp account by scanning a QR code, the same
way "Linked Devices" works in the WhatsApp app. This is **not** the
official WhatsApp Business API — it's an unofficial protocol client, which
is against WhatsApp's Terms of Service. Meta does detect and ban accounts
that behave like automated clients. If the linked number is someone's
primary daily-driver number, a ban takes out their real WhatsApp too.

**Use a spare number / secondary SIM for this**, not her main line.

1. `npm start`
2. A QR code prints in the terminal.
3. On the spare-number phone: WhatsApp → Settings → **Linked Devices** →
   **Link a Device** → scan the QR code.
4. Once connected you'll see `WhatsApp connected. Listening for messages...`.
   Session credentials are saved to `auth/` (gitignored) so it stays linked
   across restarts — no need to rescan every time.
5. Message that number from her phone to start the conversation.

To run the offline unit tests (no network: `fetch` is mocked, so they never
touch the live AI Search instance): `npm test`.

To test the retrieval+synthesis pipeline without touching WhatsApp at all
(this one is live: AI Search + OpenAI):

```sh
node src/test-pipeline.js "How to come to Canada?"
```

To simulate a full conversation (including the PR/citizenship intake) with
no WhatsApp connection — a message literally equal to `__RESTART__`
simulates a process crash (compiles a fresh graph instance mid-conversation,
same checkpointer/thread) to verify state survives it:

```sh
node src/simulate.js "hi" "2" "1" "__RESTART__" "menu" "1" "2"
```

## Keeping it running

Manually, this is a foreground Node process — `npm start` and leave the
terminal open. For anything more permanent, see the Nix flake below, which
supervises it declaratively (auto-restart on crash/reboot) instead.

## Nix

This repo is a self-contained flake — packages + devShell + a home-manager
service module — so any Nix system can run this bot from a one-line flake
input, no manual `npm install` or hand-written service unit needed.

```sh
nix build            # .#default — a real buildNpmPackage derivation
nix develop          # devShell: nodejs + psql, for local dev/debugging
```

Supported systems: `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`
(`x86_64-darwin` is excluded — nixpkgs-unstable dropped it entirely).

**As a service**, from a consuming flake:

```nix
{
  inputs.ircc-whatsapp-bot.url = "github:kattakath/ircc-whatsapp-bot";
  inputs.ircc-whatsapp-bot.inputs.nixpkgs.follows = "nixpkgs";
  # ... in your home-manager modules:
  #   ircc-whatsapp-bot.homeManagerModules.default
  #   { services.irccWhatsappBot = {
  #       enable = true;
  #       allowedNumbers = [ "15145551234" ]; # real numbers -- keep this in a private flake
  #       localRag.enable = true; # no Postgres of your own yet? see below
  #     }; }
}
```

See `nix/module.nix` for the full option surface (`package`, `stateDir`,
`model`, `langsmithTracing`/`langsmithProject`/`langsmithShowContent` (traces hide message text unless this is set), `aiSearch.accountId`/
`aiSearch.instance`, `ragdbUri`, `localRag.enable`, `environmentFile`,
`keychainServices`, `openaiBaseUrl`).
`openaiBaseUrl` points synthesis at any OpenAI-Responses-compatible endpoint
instead of api.openai.com: a local Ollama works as-is
(`openaiBaseUrl = "http://127.0.0.1:11434/v1"; model = "qwen3-vl:4b-instruct";`),
and then no OpenAI key is looked up or needed.
`aiSearch.accountId` is the Cloudflare account id (set it in the consuming
flake, or put `CF_ACCOUNT_ID` in `environmentFile`). Secrets
(`OPENAI_API_KEY`/`SERPER_API_KEY`/`LANGCHAIN_API_KEY`/
`CLOUDFLARE_AI_SEARCH_TOKEN`) are never read from Nix: set `environmentFile`
to a `KEY=value` file outside Nix (required on Linux). On Darwin the login
Keychain fills whatever that file leaves empty (the AI Search token's item is
`cf:cloudflare.com:ai-search`). `keychainServices` maps an env var to a
different Keychain item name, and can also supply `ALLOWED_NUMBERS` and
`CF_ACCOUNT_ID`, so a **public** consuming flake carries no personal data:

```nix
services.irccWhatsappBot.keychainServices = {
  SERPER_API_KEY = "serper.dev:api";
  ALLOWED_NUMBERS = "ircc:whatsapp:allowed-numbers"; # comma-separated digits
  CF_ACCOUNT_ID = "cf:cloudflare.com:account-id";
};
```

The service refuses to start with an empty `ALLOWED_NUMBERS`: unset, the bot
would answer anyone. Use `botOnly` on a host that already runs its own
Postgres, and set `ragdbUri` there. Runs under `launchd` on
Darwin, `systemd --user` on Linux (Linux path is real but untested — no
Linux host runs this today).

**The Postgres dependency (checkpoints only)**: the bot needs a reachable
Postgres for its LangGraph checkpoints. Retrieval no longer touches it —
that is Cloudflare AI Search. A database is genuinely third-party
infrastructure, not something bundled into this flake: bundling it in would
mean any host running something *else* that also needs Postgres ends up
with two redundant, possibly conflicting instances. Instead, following the
same `services.<app>.database.createLocally` idiom nixpkgs itself uses (see
e.g. `services.paperless.database.createLocally`):
- **Already have a Postgres?** Leave `localRag.enable` at its default
  (`false`) and point `ragdbUri` at it.
- **Starting from nothing?** Set `localRag.enable = true` — this module
  always imports [nix-local-rag](https://github.com/kattakath/nix-local-rag)
  (a separate, independently reusable flake: pgvector + Ollama, launchd/
  home-manager) and, when enabled, turns on its
  `services.pgvectorLocal`/`services.ollamaLocal` for you. `ragdbUri`
  already defaults to that service's own connection string, so no further
  config is needed either way.

**Caution**: never run the built binary (or `nix build`'s `result/`) from a
directory that holds a *live, paired* `auth/` session while that session's
real bot process is also running — Baileys/WhatsApp treats it as a second
device on the same credentials and will force both connections to
re-pair. The packaged deployment avoids this by running from an isolated
`stateDir` (default `~/.local/state/ircc-whatsapp-bot`), separate from any
manual checkout's `auth/`.

## What's in the RAG store right now

**300 official canada.ca IRCC pages**, one AI Search item each (corpus
`ircc`; the instance chunks and embeds them — the old pgvector store held
the same pages as 3,170 hand-made chunks), plus the CRAG write-backs
(corpus `ircc-live`). The pages were crawled via the Apify
`apify/website-content-crawler` actor from the 5 top-level `/services/` hub
pages (citizenship, immigrate/PR, study, work, visit), scoped to
`.../services/**` (depth 3, capped at 300 pages — deliberately bounded, not
the entire canada.ca domain, to avoid diluting retrieval with press
releases/corporate content). Adaptive rendering handles JS-heavy pages
properly, unlike the original plain-fetch ingestion.

Each item's key is derived from its page URL (`itemKey` in
`src/aisearch.js` — `ircc/<url slug>-<sha1 prefix>.md`, byte-identical to the
key the one-off migration export gave it, pinned by `npm test`), so
re-ingesting a page overwrites its item instead of adding a duplicate.

Each page is tagged with a per-topic `source` derived from its URL path
(`ircc-crawl-citizenship`, `ircc-crawl-pr`, `ircc-crawl-study`,
`ircc-crawl-work`, `ircc-crawl-visit`, `ircc-crawl-refugees`,
`ircc-crawl-passports`, `ircc-crawl-other` for everything else under
`/services/` — mostly application forms/guides) — `graph.js`'s
`TOPIC_BRANCHES`/`BRANCH_SOURCES` filter retrieval by these exact tags, so
if you re-crawl, keep the tag scheme in sync with `scripts/crawl-pages.js`'s
`TOPIC_MAP`, or the menu branches will silently return no results.

**Staleness risk**: this content changes — the initial crawl already picked
up a December 2025 legal change (Bill C-3) and 2026 travel restrictions.
Without a refresh, an answer that's accurate today can quietly go stale.

**To re-crawl and re-ingest manually**:
```sh
node scripts/recrawl.js
```
Standalone — triggers the Apify actor via its REST API (needs
`APIFY_TOKEN` in `.env`), polls for completion, downloads the dataset, and
runs it through `ingest-crawl.js`: every page is an upsert, so it's safe
to re-run. Once **every** upload has succeeded, it deletes the `ircc/` items
from this tag prefix that the new crawl no longer contains — and refuses to
delete anything if an upload failed, the crawl came back implausibly small
(under half the existing items), or an item has no metadata yet (still
indexing). `ircc-live` items are never deleted. Needs `CF_ACCOUNT_ID` (in
`.env`) and the AI Search token (env or Keychain, as above). No interactive
MCP tools needed.

**To run it automatically, monthly**:
```sh
cp scripts/com.ismailkattakath.ircc-whatsapp-bot.recrawl.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ismailkattakath.ircc-whatsapp-bot.recrawl.plist
```
Runs the 1st of each month at 3am (before the bot would typically be in
active use). Logs to `~/Library/Logs/ircc-whatsapp-bot-recrawl.log`. This
is a plain `launchd` plist scoped to this project — not wired into
home-manager, so it's simple to install,
inspect, or remove (`launchctl unload ...` + delete the file) without
touching anything else.

**Durable version** (`scripts/inngest/`) — same logic (shared via
`scripts/crawl-pages.js`), but each page is an independent, retried
[Inngest](https://www.inngest.com) step instead of one long synchronous
loop, and the stale cleanup is a last step that runs only after every page
step succeeded. A crash/kill mid-run resumes without redoing
already-completed pages. A step killed mid-page simply re-runs: the page is
one upsert keyed by its URL, so a retry overwrites the same item rather than
adding a duplicate (the old pgvector ingest needed a per-page transaction
for that). Useful for a large/flaky re-crawl; overkill for the normal case.
To use:
```sh
npm run inngest:serve        # terminal 1
inngest dev                  # terminal 2 (local Dev Server, UI on :8288)
node scripts/inngest/trigger-ingest.js <dataset.json> ircc-crawl   # terminal 3
```

## Legal boundary — read this

In Canada, only **RCICs** (Regulated Canadian Immigration Consultants),
lawyers, or Quebec notaries may legally give *paid* immigration advice or
representation (IRPA s.91). This bot is informal, unpaid help for a friend
— fine. It should **not** be presented as professional/official advice,
handed out to others as a "consulting" service, or relied on for anything
that actually affects a real application without double-checking on
canada.ca or with a licensed professional. The bot's own answers are
instructed to say this every time, but the human framing around it (how
it's introduced, who else gets access) is what actually keeps this on the
right side of that line.
