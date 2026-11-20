# Conversation design for the IRCC WhatsApp bot (revision 3, after red-team and advisor review)

**Scope:** an integrated spec built from 6 SME reports (repair, turn-taking, platform, context, input robustness, answer quality, test engineering).
- Revision 2 answered 39 red-team objections: 24 from the user advocate and 15 from the platform reviewer.
- Revision 3 applies **6 advisor must-changes**, each verified against the code first. See **Advisor review** at the end.

Everything here is **read-only analysis**: no repo edits, no real chats, no WhatsApp connection.

**Evidence labels**
- **measured**: reproduced in an offline MemorySaver probe or a counted measurement.
- **read**: seen in the bot code, the vendored Baileys/LangGraph source, or a fetched primary page.
- **inferred**: follows from the code, not executed.
- **unverified**: a secondary web source only.
- **judgement call**: no source settles it.

**Re-checked at the source on 2026-11-19 (read)**
- **Repo state:** `marked` is not a dependency. `src/` has no `retryPolicy`, `readMessages` or `quoted` usage. `test/` holds only `aisearch.test.js`.
- **`graph.js`:**
  - `looksLikeRealQuestion` is `text.trim().length > 12`. It is called in `routeFromStart` (over 12 chars goes to `quickAnswer`, otherwise to the menu) and in the slot-fill side-question check.
  - `isResetCommand` is a word-boundary match within 30 chars. Its comment says "menu please" should reset.
  - `YES_WORDS` is `y, yes, yeah, yep, ya, yup` and `NO_WORDS` is `n, no, nope, nah`. Both are English-only, with no "ok" and no 👍.
  - `MENU_TEXT` **and `GREETING_TEXT`** both say "using the official IRCC website". `GREETING_TEXT` also carries the persona line.
  - The `CITIZENSHIP_SLOTS.yearsPresent` prompt says "A rough number is fine."
  - A comment says the similarity threshold was tuned on AI Search's qwen3-embedding-0.6b, and that "the probe is English and well-formed".
- **`index.js`:**
  - `STALE_MS` is 7 days.
  - **The media nudge in `messages.upsert` calls `sock.sendMessage` with no `isAllowed` check.**
  - `processMessage` logs `[in]  ${jid}: ${text}` **before** the allowlist check. Its `catch` sends "Sorry, something went wrong…" even when `isAllowed()` itself threw.
  - An `isAllowed` false only logs ("Ignored message from non-allowlisted number").
  - `MAX_RECONNECT_ATTEMPTS = 3`.
  - The filler fires at 4,000 ms. Composing refreshes every 8,000 ms.
- **`index.js` and `simulate.js`** both build `PostgresSaver.fromConnString(process.env.RAGDB_URI ?? "postgresql://mcp@127.0.0.1:5433/ragdb")`, which is the live checkpoint database.
- **`aisearch.js`** reads the token from the login Keychain: `execFileSync("/usr/bin/security", ["find-generic-password", …, KEYCHAIN_SERVICE, "-w"])`.
- **`websearch.js`:**
  - `fetchPageText` calls `fetch(url)` with the default redirect handling and never checks `res.url`.
  - `persistWebFallback` calls `db.js persistChunk`.
- **`llm.js` SYSTEM_PROMPT:** "Always answer in English, even if the question was asked in another language", with a one-line English acknowledgement.
- **LangGraph 1.4.12** (installed):
  - `addNode` takes `timeout?: number | TimeoutPolicy` (`dist/graph/state.d.ts`). `PregelOptions.stepTimeout` exists (`dist/pregel/types.d.ts`).
  - `TimeoutPolicy` doc: "the timer resets for each retry attempt". Cancellation is cooperative: it aborts the node's `AbortSignal` and drops its buffered writes (`dist/pregel/utils/timeout.d.ts`).
  - `RetryPolicy.retryOn?: (e) => boolean` is checked in `dist/pregel/retry.js`.
- **Baileys:**
  - `messages-recv.js` emits `'append'` at 4 sites: newsletter plaintext, a node-attrs `fullMsg`, `node.attrs.offline`, and offline calls. `messages-send.js` also emits it when relaying own sends.
  - `sendActiveReceipts` follows `isOnline`.
  - `readMessages` sends `read` only when the bot's `readreceipts === 'all'`, and `read-self` otherwise.
  - `chats.js` sends `available` or `unavailable` on connect, depending on `markOnlineOnConnect`.
  - `WAProto` `IContextInfo` has `isForwarded` and `forwardingScore`.
  - `Utils/messages.js`: the `quoted` block calls `normalizeMessageContent(quoted.message)` and `getContentType`, so it needs the full message.
  - `Types/Message.d.ts` has `buttonReply` and `listReply` send content, but no `buttonsMessage` or `listMessage` send content.
- **WhatsApp Messaging Guidelines** (fetched 2026-11-19 through a summarising fetch tool) list "use unofficial clients, bulk messaging, auto-messaging … or automation" as prohibited. The page date the tool reported conflicts with the objector's 2024-02-16, so no date is relied on.

---

## 1. Verdict: the top 5 problems

**1. The bot sometimes answers the wrong message, the wrong person, or nothing.**
- The first question goes unanswered: `graph.js routeFromRoot → greetingNode` (**measured**).
- After an error, the next message is dropped and the old question re-runs: `index.js processMessage` (**measured**, MemorySaver).
- Offline messages get delivered ticks, then silence: `index.js messages.upsert`, `type !== "notify"` (**read**).
- Wrapped and captioned messages are dropped or misread (**read**).
- A known contact whose `@lid` fails to resolve is ignored, with no alert: `index.js processMessage → isAllowed` (**read**).
- **Allowlist bypass: any non-allowlisted sender who sends a photo, voice note, document or sticker gets an automated reply.** The `index.js messages.upsert` media-nudge branch has no `isAllowed` check. The `processMessage` catch also replies when `isAllowed` threw (**read**).

**2. Every short reply becomes a slow, stand-alone question.**
- "thanks", "1.", "hello??", "no I meant study permit" and "wait I'm 34" each trigger ~27 s of retrieval and LLM work: `graph.js routeFromMenu`, `answerFreeform` (**measured**).
- There is no dialogue-act gate and no conversation context.
- A narrative passes the `length > 12` test and goes to RAG (**read**).

**3. Output trust rests on the prompt alone, and the prompt does not hold.**
- `**double**` bold and invented URLs reach the phone: `llm.js synthesize` returns raw text (**read** + live).
- The disclaimer and the sources are written by the model.
- The web fallback can persist off-domain pages, including through a redirect: `websearch.js webFallback`, `fetchPageText` (**read**).

**4. Intake answers are silently corrupted and cannot be corrected.**
- "about 3 years" becomes **3 days**. "2 or 3 years" becomes **23 days**: `graph.js CITIZENSHIP_SLOTS` (**measured**). The bot's own prompt invites the estimate ("A rough number is fine", **read**).
- Nothing is echoed back, and there is no correction path.
- "start over" keeps the stored answers, because the `slots` reducer merges (**measured**).

**5. Turn-taking ignores what WhatsApp already offers.**
- Messages are handled strictly one per turn: no merging, no quoted replies, edits ignored.
- There are no read receipts and no step deadline. The OpenAI SDK default is 600 s × 3 attempts.
- Root cause: `processMessage(jid, text)` never receives `msg.key` (**read**).

---

## 2. Principles adopted

| # | Principle | Source (precedent) | Beat |
|---|---|---|---|
| P0 | **Allowlist first.** No outbound event of any kind goes to a sender who is not allowlisted. | Data minimisation (P15); WhatsApp Messaging Guidelines (**read**) | Per-branch checks that a new branch forgets |
| P1 | **Answer the question asked**, in the same turn. | Schegloff 1968, conditional relevance; Google greetings guidance | A greeting gate before any answer |
| P2 | **Code owns structure; the model owns prose only.** | Live `**` failure; ALCE (Gao et al. 2023): ~50% of citations lack full support | Stricter prompt rules |
| P3 | **Repairs offer options and explanations**, not dead ends. | Ashktorab et al., CHI 2019; Google system-errors guidance | "try again in a moment" |
| P4 | **Escalating no-match:** reprompt, then an example, then an exit. | Google conversation design, errors | A fixed "didn't catch that" |
| P5 | **Confirm implicitly by default, and explicitly when a mistake is costly.** Never turn an estimate into a legal threshold. | Google confirmations; canada.ca physical-presence calculator page (**unverified** summary) | Confirming everything, or nothing |
| P6 | **Make correction and dismissal efficient.** | Amershi et al. CHI 2019, G8–G10 | "type restart to fix it" |
| P7 | **Honour self-repair.** A correction supersedes the item it repairs, and the superseded answer is never sent. | Schegloff, Jefferson & Sacks 1977 | Answering the withdrawn question first |
| P8 | **One open question per bot turn.** | Grice 1975, maxim of manner | A menu appended to every answer |
| P9 | **Idempotent intake plus an outbox**, deduped by id **and**, for free-text questions only, by content. | Richardson, Idempotent Consumer; Amazon SQS FIFO content-based deduplication (5-min window) | Dropping or replaying everything; dedupe that also swallows repeated choices |
| P10 | **Deadline budget per turn**, built on LangGraph's own node `timeout` plus the abort signal threaded into each call. | gRPC deadlines; Google SRE book; LangGraph 1.4.12 `TimeoutPolicy` (**read**) | Unbounded waits; a hand-rolled timer stack |
| P11 | **Explain the wait once, honestly, within 10 s.** | NN/g response-time limits; Maister 1985 (unexplained waits feel longer) | A silent "typing…" or an unexplained ⏳ |
| P12 | **Inverted pyramid and progressive disclosure.** | NN/g | Auto-splitting into bursts |
| P13 | **Taper repeated prompts and warnings.** | Google tapering; Akhawe & Felt 2013 | The same footer on every answer |
| P14 | **Platform-native first, and counted.** Use what Baileys and LangGraph ship, and state the outbound events each feature adds per turn. | Vendored Baileys `lib/`; WhatsApp Messaging Guidelines (**read**) | Hand-rolled copies; uncounted "low risk" ratings |
| P15 | **Data minimisation.** | PIPEDA Principle 5, used as a **benchmark** | "Only family uses it" |
| P16 | **Say what the bot is**: a family helper, not IRCC and not a person. | California SB 1001 (bot disclosure); EU AI Act Art. 50 (precedent, not binding here); IRCC protect-fraud page | Implied authority via 🍁 and "official IRCC info" |
| P17 | **Language floor: never regress today's non-English path.** Add a small multilingual yes/no lexicon at prompts. Free text in any script keeps today's path (RAG, then an English answer with an acknowledgement, `llm.js SYSTEM_PROMPT`, **read**). No canned "English only" line until a cross-lingual retrieval probe exists. | `llm.js SYSTEM_PROMPT` (read); the lexicon is a judgement call | A script-detection "English-only" refusal that is worse than today |
| P18 | **Gate order: the pending prompt binds first.** Control verbs, then the pending-prompt parse, then dialogue-act classes, then RAG. | Rasa form validation (slot mapping before intent fallback); Google no-match guidance | Classifying "ok" or 👍 as an ack while a yes/no prompt waits |

### 2b. Conflicts resolved

| # | Conflict | Decision | Overruled, and why |
|---|---|---|---|
| C1 | What happens after an error | **Measured:** the new text is dropped and the old node re-runs. FIX-03 step 1 re-checks this on a scratch Postgres (never `RAGDB_URI`, see §7). | TT-02's "2nd RAG" mechanism: it is inferred, and 3 probes contradict it. |
| C2 | Which message wins after a terminal failure | **The new message wins.** The failed question is offered back ("send *again*" or "try again"). | "Finish the old turn first": it spends ~27 s on a question the user may have abandoned, and the answer arrives out of order. |
| C3 | Auto-retry (**revised**) | **Yes for fast transient errors** (connection refused, 5xx), via `retryPolicy` with maxAttempts 2. **No retry on timeouts:** `retryOn` returns false for `NodeTimeoutError` and abort errors. `retryOn` exists (**read**). That timeout errors reach it is **inferred**, so L1 asserts it. | A blanket rejection: its latency worry applies to timeouts only. Without the exclusion, the doc's "the timer resets for each retry attempt" (**read**) would double the 120 s budget. |
| C4 | A correction or control message arrives mid-flight | **Hold-and-supersede.** See below the table. | **"Finish and send both"** (the previous default, user-1): ships an answer the user withdrew. **Abort-and-rollback now** (platform-8): builds on an unverified PostgresSaver mechanism, and it is the L-sized part. |
| C5 | Wait signal | **One explanatory filler**, no reaction. See below the table. | **The ⏳ ladder** (platform-1/2, user-10/11). Reactions to the user's own message notify too (**unverified**, several secondary sources). Removing one is a second send. A ⏳ explains nothing (Maister). It added 2–3 events per turn in a uniform rhythm. |
| C6 | Formatter | **`marked` lexer plus a small regex pass.** The model writes standard Markdown (prompt changed), so the lexer and the prompt agree, and `*x*` is italic by definition. | **A hand-written parser** (AQ-05). **The "single-asterisk bold" prompt** (platform-6): a CommonMark lexer turns that into italics. |
| C7 | Slot extractor | **Probe Recognizers-Text first**, otherwise a deterministic parser. **Estimates and ranges for physical presence are never converted to days.** The bot points to the official calculator. The `yearsPresent` prompt drops "A rough number is fine" and asks for the exact days or "not sure". Whether an informal check may **continue** with an estimate is open question 23. | Converting "about 3 years" to 1,095 days (user-7): it rounds a guess onto the legal threshold. A prompt that invites an estimate it then rejects. |
| C8 | Reset matching | **Normalise first, then match.** See below the table. | **Start-anchored `cancel`** (user-2): "cancel my visa application" is a real question. **Raw whole-message matching** (user-14): it would break "menu please", "Menu?" and "show menu". |
| C9 | Stale-session boundary | **Two clocks.** Referent context (`lastTurns`, `lastSources`, `answerRemainder`) expires after **4 h** (judgement call). An open **intake stays for 7 days**, today's `STALE_MS` (read). A **slot-valid** reply after a gap is accepted ("Welcome back — age 34, got it"). Only an off-slot message gets the resume card. | **One 4 h boundary for everything** (user-3): it eats a valid "34" and shortens today's window 42x. |
| C10 | Menu reminder | **Taper it:** show the one-line hint on the first answer of a session, and when the user seems stuck. Ordered steps render as "Step 1:", never a bare leading digit, so a bare digit still means a menu choice. | **Dropping it** (R11). **"Numbers never appear"** (user-20): it loses step order. |
| C11 | When to quote | **Only when adjacency is broken and the inbound `WAMessage` is in hand.** See below the table. | **Quoting every late reply** (platform-4): it needs a persistent inbound store that §5 forbids. **WA-04's "> 10 s elapsed" trigger.** |
| C12 | Web-fallback host check (**revised**) | **Exact `hostname === "www.canada.ca"` plus a path prefix of `/en/immigration-refugees-citizenship`**, checked on the Serper URL **and again on the final `res.url` after redirects**, before parse and before persist. | A suffix test, which matches `evilcanada.ca`. A pre-fetch-only check, which a canada.ca redirect bypasses. |
| C13 | How much history to keep | **A bounded window (last 2 question/answer pairs) plus a gated rewrite.** | A full transcript; LLM summaries. |
| C14 | "no that's wrong, I asked for my mother" | **New content wins.** A complaint that still has content after the complaint words are stripped takes the **rewrite path**, with a one-line apology. Only a bare complaint ("wrong", "that is wrong", 👎) gets the options repair, **and only when no prompt is pending** (P18). | Letting the gate route every complaint to the options (user-6): it drops the correction. |
| C15 | Which prompt a digit answers | **A quoted digit binds to the quoted prompt** (prompt message ids are kept in state). An unquoted digit whose `messageTimestamp` is **earlier than the send time of the current prompt** is ambiguous and gets one confirm line. Otherwise it binds to the current prompt. **A repair marker plus a value** ("sorry 2", "sorry 30") **re-binds the last answered prompt** (judgement call). New choice points use **words** where possible ("study, work or visitor?"). | **"Last valid choice wins" alone** (user-15): it binds a late digit to the wrong prompt. |
| C16 | Scope | **Cut** `presenceSubscribe` and the precomputed link preview (old FIX-30). **Park** FIX-24/25/27/31 as "revisit after metrics". **Keep** the new edge cases: the user asked for every edge case, and most are gate branches, not machinery. Every P1 must fail on today's `main` in the L1/L2 harness before it lands. | **Adding more platform surface** (platform-9); **cutting edge-case coverage**. |
| C17 | Buffer vs fast replies (**new**) | **Bypass the coalescing buffer** for a message that fully parses as the pending prompt's choice or slot answer, a C8 control verb, or a prod. It is dispatched at once. A follow-up correction ("sorry 2") is then handled by C15's re-bind, not by merging. Judgement call. | Holding every message 2.5 s: it breaks S16 (~1 s), S17 (< 2 s), S37 (~2 s) and the "read receipt < 3 s" metric. |
| C18 | Gate order (**new**) | **P18 order:** (1) C8 control verbs; (2) the pending-prompt parse (yes/no including "ok" and 👍, recap OK, choice with C15 binding, slot); (3) dialogue-act classes (closing, ack, noise, prod, identity, complaint, problem statement); (4) RAG. | Dialogue-act classes first: "ok", 👍, "no" or "wrong" at a yes/no or recap prompt would be swallowed. |
| C19 | Content dedupe scope (**new**) | **Free-text RAG question turns only**, keyed on the normalized text **plus the pending-prompt id**. Never choices, slot answers, control words, greetings or prods. | Dedupe on every message: it absorbs the second "2" in S14, the repeated "menu" in S16, the "blue" repeats in S28 and the second "hi" in S02. |

**C4 in full (hold-and-supersede)**
- The in-flight run finishes, but its answer is **never sent** and never written to `lastTurns`.
- A **repair-marked** message gets an immediate one-line ack ("Got it — study permit instead, one moment").
- The superseded run's **60 s line and 120 s deadline message are cancelled**.
- The merged turn then runs, **carrying the withdrawn question's text** as its referent. So "sorry I mean study permit" resolves to the full corrected question. **That resolution needs FIX-16's rewrite.** Until FIX-16 lands, the merged turn sends the concatenated text "withdrawn + correction" to retrieval (inferred to be weaker; S21 is scoped to assert only the never-sent part).
- A **control** message (`menu`, `never mind`) gets its **static reply at once from the transport**. The reset is applied to graph state after the in-flight run resolves.
- **How the deferred reset is applied:** the transport resumes the held thread with the control word under a `suppressReply` flag. The graph's own menu interrupt text is **not sent**, because the static reply already went out. `pendingMessage` (which still holds the withdrawn answer in the checkpoint) is overwritten with `null` in the same update (inferred; L1 asserts no second menu and `pendingMessage === null`).
- **No abort and no rollback** until open question 1 is settled (FIX-37, P2). The cheaper `TimeoutPolicy` write-drop probe (open question 20) runs first.

**C5 in full (wait signal)**
- **The sequence:**
  1. Read receipt at turn start (only once open question 15 confirms `readreceipts === 'all'`).
  2. Composing, as today.
  3. **One** explanatory filler text at ~4 s, on RAG turns only, with an honest estimate.
  4. "Still working" at 60 s.
  5. The deadline at 120 s.
- **How "RAG turns only" is known:** the turn runs through `graph.stream` with `streamMode: "custom"`. The retrieval node emits a `{phase: "retrieving"}` event, and only that event arms the filler timer. Turns that C17 bypasses or that the gate answers never emit it. Fallback, if the stream path is not built: the 4 s timer stays the proxy, and deterministic replies come back in under 4 s so it never fires (inferred).
- A prod ("hello??") gets one status reply.
- There is **no ⏳ reaction and no 20 s quoted status**.
- The budget is per inbound message (§4), and L2 asserts it.

**C8 in full (reset matching)**
1. **Normalise:** lowercase, and strip punctuation, emoji and politeness tokens (please, pls, plz, show, main, the, go back to, can you, ok).
2. **Whole message:** the control verbs `menu`, `reset`, `restart`, `start over`, `start again`, `never mind`, `forget that` and `new question` match when they are the **whole remaining message**.
3. **Anchored at the start:** `start over`, `never mind`, `forget that` and `new question` also match there, and the rest of the message is answered.
4. **`cancel`** matches **only as the whole message**, and only at an intake prompt.

**C11 in full (when to quote)**
- **Quote when:**
  - a newer inbound message arrived
  - the turn is merged
  - the message was recovered after being offline
  - the message is an edit (the update event carries the key and the content)
  - the reply reports an error
- **"again" after an error** quotes from an **in-memory, per-chat slot holding the last failed message (30 min TTL)**. After a restart it restates the question instead.
- **No inbound content store.**

---

## 3. Edge-case catalogue

Test ids refer to scenarios S01–S55.

| Case | Today's failure (file:function, evidence) | Pattern | Source | Test |
|---|---|---|---|---|
| **Non-allowlisted sender sends media** | `index.js messages.upsert` media nudge has no `isAllowed` (**read**) | P0: one ingress allowlist check before any send | P15; Messaging Guidelines | S52 |
| **`isAllowed` throws** | `index.js processMessage` catch sends the error text to the unknown jid (**read**) | No reply; text-free log; FIX-35 operator alert | Judgement call | S52 |
| **First message is a question or a story** | `graph.js routeFromRoot→greetingNode` (**measured**) | Answer first, with a one-line intro that says what the bot is | Schegloff 1968; P16 | S01, S02, S47 |
| **New message after an error** | `index.js processMessage` catch + `Command({resume})` (**measured**) | retryPolicy + pre-turn rollback + options repair | LangGraph fault-tolerance; Ashktorab 2019 | S03, S04 |
| **Error mid-intake** | `graph.js slotFillNode` throw leaves `next=[]` (**measured**) | Keep branch, slotIndex and slots | Same | S05 |
| **Model or network hangs** | `llm.js` OpenAI defaults; `websearch.js` and `aisearch.js` fetch with no signal (**read**) | Node `timeout` + signal threaded into each call; no retry on timeout | LangGraph `TimeoutPolicy` (read); gRPC; SRE book | S06 |
| **Formatting fails** | `llm.js synthesize` returns raw `output_text` (**read** + live) | `marked` renderer; Markdown input dialect | WhatsApp formatting FAQ (**unverified** summary) | S07 |
| **Invented URLs** | `llm.js synthesize` (**read**; eval) | Code renders the sources from retrieved metadata; `[n]` markers used when present | ALCE 2023 | S08 |
| **Wrapped messages** | `index.js messages.upsert` reads the top level only (**read**) | `normalizeMessageContent`; upsert skips `protocolMessage` | `Utils/messages.js` | S09 |
| **Captioned photo** | `index.js messages.upsert` ignores `*.caption` (**read**) | The caption is the text | Baileys proto | S10 |
| **Voice note, sticker** | `index.js` media nudge covers `audioMessage` and `stickerMessage` with one fixed line (**read**) | Voice: a tailored line plus the pending prompt. Sticker: no reply | Grice, relation; judgement call | S48 |
| **Web fallback goes off-domain** | `websearch.js webFallback` / `persistWebFallback` (**read**) | Exact host allowlist; `site:` first | Google 32-word query limit | S11 |
| **canada.ca URL redirects off the allowlist** | `websearch.js fetchPageText` never checks `res.url` (**read**) | Re-check host and path on the final URL | C12 | S55 |
| **UCI / SIN typed** | `index.js` logs the text; `websearch.js search` (**read**) | Ingress redaction | Presidio; LangSmith masking | S12 |
| **Intake profile sent to search** | `graph.js slotSynthesisNode` (**read**) | Profile-free query | PIPEDA P5 | S13 |
| **"about 3 years", "2 or 3 years"** | `graph.js CITIZENSHIP_SLOTS.yearsPresent.parse` (**measured**); the prompt invites a rough number (**read**) | No conversion; point to the official calculator; prompt asks for exact days | canada.ca calculator page (**unverified** summary) | S14 |
| **"I am 34", "Bachelors"** | `graph.js PR_SLOTS`, `parseYesNo` (**measured**) | Lenient extraction | Rasa form validation | S15 |
| **"1.", "1️⃣", "one", "7"** | `graph.js routeFromMenu` exact `===` (**read** + **measured**) | One choice normalizer; buffer bypass (C17) | Google no-match; NFKC | S16 |
| **"thanks", 👍, gibberish** | `graph.js routeFromMenu → quickAnswer` (**measured**) | Dialogue-act gate, after the pending-prompt parse (C18) | Schegloff & Sacks 1973 | S17 |
| **"ok" / 👍 / "no" at a yes/no or recap prompt** | `graph.js parseYesNo`: "ok" and 👍 are not in `YES_WORDS` (**read**) | Pending prompt binds first (C18) | Rasa form validation | S53 |
| **"that is wrong"** | `graph.js routeFromMenu` (**measured**) | Options + explanation repair | Ashktorab 2019 | S18 |
| **Complaint and correction in one message** | Gap in the previous spec (old C4/FIX-22 vs FIX-16) | C14: content wins | Schegloff et al. 1977 | S41 |
| **Burst / half-sentences** | `index.js enqueue` (**read**) | Coalescing buffer (2.5 s quiet, 8 s max), bypassed for full parses (C17) | Judgement call (n8n templates are examples, not a standard) | S19 |
| **Choice answered twice** | `index.js enqueue` + the pending prompt (**read**) | Immediate dispatch, then C15 re-bind | TT-03 trace | S20 |
| **Late or quoted digit** | `graph.js routeFromMenu` binds to the pending interrupt (**read**) | C15 binding | Baileys `contextInfo.stanzaId` | S46 |
| **Correction while generating** | `index.js enqueue` FIFO (**read**) | C4 hold-and-supersede + ack | Schegloff et al. 1977 | S21 |
| **"menu" during a 30 s answer** | `index.js enqueue` single lane (**read**) | Static fast-path reply; reset applied after, its graph reply suppressed | Nielsen heuristic #3 | S22 |
| **"hello??" / "are you there" during the wait** | `index.js enqueue` queues a new turn (**read**) | One status reply; not merged; not a new turn | NN/g; Maister | S42 |
| **Sent while offline** | `index.js` `type !== "notify"` (**read**) | Acceptance predicate + window + one coalesced note beyond it | Idempotent consumer | S23 |
| **Same question resent on flaky data** | `index.js enqueue`, no content check (**read**) | Content dedupe for free-text questions only (C19), 10 min window | SQS FIFO content dedupe | S45, S54 |
| **Edit / delete** | `index.js` listens only to `messages.upsert` (**read**) | One edit path; re-answer only on a meaningful change | Telegram `edited_message`; Schegloff 1977 | S24, S25 |
| **Out-of-order slot correction** | `graph.js slotFillNode` (**measured**) | Correction + recap | Rasa `pattern_correction` | S26 |
| **Reset vocabulary** | `graph.js isResetCommand` (**read**) | C8 | Rasa cancel/restart patterns | S27 |
| **Repeated no-match** | `graph.js slotFillNode` (**measured**) | Escalating no-match | Google errors | S28 |
| **Side question mid-intake** | `graph.js slotFillNode` (**read**) | Continue-interrupted | Rasa | S29 |
| **"no I meant study permit"** | `graph.js answerFreeform` (**measured**) | Gated rewrite + heading | CANARD 2019 | S30 |
| **Quote-reply to an older answer** | `index.js` ignores `quotedMessage` (**read**) | The quote is the referent | Baileys `IContextInfo` | S31 |
| **Start over, then a pronoun** | `graph.js` slots reducer (**measured**) | `Overwrite`; clear the context | LangGraph `Overwrite` | S32 |
| **Return after hours or days** | `index.js processMessage` isStale (**measured**) | C9 two clocks | Rasa `session_config` | S33 |
| **Waiting 19–56 s** | `index.js processMessage` filler (**read**) | C5 | NN/g; Maister | S34, S06 |
| **Filler arrives after the answer** | `index.js processMessage` `finally` (**read**) | Cancel before commit | — | S34 |
| **"Read more"; "pls continue"** | `graph.js menuNode` (**read**) | BLUF + length cap + tolerant *more* | NN/g | S35 |
| **Disclaimer** | `llm.js SYSTEM_PROMPT` (**read**) | Code-appended, tiered by stakes | Akhawe & Felt 2013 | S36 |
| **Unanswerable / vague question** | `graph.js answerFreeform` (**read**) | Answerability flag; one clarifying question | CRAG; Aliannejadi 2019 | S37 |
| **Narrative with no question** | `graph.js routeFromStart`: over 12 chars goes to `quickAnswer` (RAG); a new chat gets the greeting (**read**) | Detect the problem statement, then ask one clarifying question | Aliannejadi 2019 | S47 |
| **Compound question** | `graph.js answerFreeform`: one retrieval and a 5-bullet cap (**inferred**) | Split (≤ 3), retrieve per part, one combined answer, name the rest | Self-Ask (Press et al. 2022); LangChain query decomposition | S43 |
| **Latest draw / processing time** | `websearch.js fetchPageText` cap (**measured**) | IRCC JSON route | canada.ca data files | S38 |
| **Socket reconnects mid-turn** | `index.js start()` (**read**) | Single writer; module-scope outbox; one coalesced flush | Transactional outbox | S39 |
| **Non-English reply** | `graph.js YES_WORDS` / `NO_WORDS` are English-only (**read**); free text already gets an English answer with an acknowledgement (`llm.js SYSTEM_PROMPT`, **read**) | Small multilingual yes/no lexicon at prompts; free text keeps today's path | P17; judgement call | S40 |
| **"are you IRCC?", "real person?"** | `index.js` filler "official IRCC info… 🍁"; `graph.js MENU_TEXT`, `GREETING_TEXT` (**read**) | Fixed identity and handoff reply | P16 | S44 |
| **Forwarded scam text** | `index.js` ignores `contextInfo.isForwarded` (**read**) | Fraud-check route; never restate the claims | IRCC protect-fraud page | S51 |
| **Known contact, unresolved `@lid`** | `index.js processMessage → isAllowed` logs and returns (**read**) | Retry resolution + operator alert; no user reply | Judgement call | S49 |
| **"forget me"** | Gap in the previous spec (old §5) | Whole-message match + explicit confirm | P5 | S50 |

---

## 4. Platform features: use / avoid

**Preamble**
- WhatsApp's Messaging Guidelines prohibit unofficial clients and automation (fetched 2026-11-19; the quoted phrase is **read**, the page date is unsettled).
- So this deployment is out of policy whatever features it uses.
- The only lever left is to **minimise the number and regularity of automated outbound events**.
- WhatsApp's 2019 abuse whitepaper reportedly says most bans are proactive (over 75% without a user report). That figure is **unverified**: the primary document was not fetched.
- The last column below is a **count**, not a risk rating.

**Per-turn outbound budget today** (read, `index.js processMessage`)
- Composing at the start, plus a refresh every 8 s (~4 on a 27 s turn).
- 1 filler text at 4 s.
- 1 answer.
- **Plus one automated reply to any sender's caption-less media, allowlisted or not** (the bypass FIX-40 removes).

**Budget after this spec, per inbound user message**
- **0 events of any kind to a non-allowlisted sender** (P0, FIX-40).
- Today's events plus **1 read receipt**, once open question 15 confirms it is visible.
- At most **one** bot text before the answer: the filler, an ack or a status.
- **Exceptions, each a direct reply to a user message:**
  - the correction ack (S21)
  - the static control reply (S06, S22)
  - one prod status (S42)
- A merged or superseding turn does not get a second filler. The ack takes its place.
- The 60 s line fires only on turns past p95.
- L2 asserts this budget for every fixture.

### Use

| Feature | Evidence | Use it for | Outbound events per turn |
|---|---|---|---|
| `normalizeMessageContent` + `getContentType` | `Utils/messages.js` | Every inbound message | 0 |
| Read `contextInfo.quotedMessage` and `isForwarded` | `WAProto` `IContextInfo` | Referents; the forwarded route | 0 |
| `messages.update` edits and revokes | `Utils/process-message.js` MESSAGE_EDIT / REVOKE | Self-repair; the only edit path | 0 |
| Quoted reply `{quoted: msg}` | `Utils/messages.js` options.quoted (needs the full `WAMessage`) | Broken adjacency only (C11) | 0 extra (it changes an existing send) |
| `readMessages(keys)` | `Socket/messages-send.js`: sends `read` only if the bot's `readreceipts === 'all'`, else `read-self` | Mark the turn's messages read at turn start. **Precondition:** the bot account has read receipts on (open question 15). Otherwise it adds a stanza with no visible benefit, so it stays off. No jitter, because the jitter folklore has no source. | +1 |
| `composing` presence | `Socket/chats.js` sendPresenceUpdate | As today, capped by the deadline | 0 change |
| `ephemeralExpiration` on the reply | `Utils/messages.js` | Follow the chat's disappearing timer | 0 |
| LangGraph node `timeout` / `TimeoutPolicy`, `retryPolicy.retryOn` | `@langchain/langgraph` 1.4.12 `dist/graph/state.d.ts`, `dist/pregel/utils/timeout.d.ts`, `dist/pregel/retry.js` | The per-turn deadline (P10), with no retry on timeout (C3) | 0 |

### Avoid

| Feature | Why | Evidence |
|---|---|---|
| **Buttons / lists** | rc14 has no `buttonsMessage` or `listMessage` send content in `AnyRegularMessageContent`, only the `buttonReply` / `listReply` reply types. They are a Business-Platform feature. | `Types/Message.d.ts` (**read**); Meta interactive-messages doc |
| **Polls as menus** | Votes arrive encrypted and need a store; users can change votes after the bot has moved on | Baileys README |
| **⏳ reaction as a wait signal** | Likely notifies ("reacted ⏳ to…"); removing it is a second send; it explains nothing | **unverified** secondary sources (Android Police, 9to5Mac 2022); Maister 1985 |
| **`markOnlineOnConnect: false`** | The README gives its purpose as phone notifications only. Side effects: `unavailable` sent on connect, and delivery receipts sent as `inactive`. "Online per turn" toggling would add 2 presence nodes per turn. | README; `chats.js`; `messages-recv.js` `sendActiveReceipts` (**read**) |
| **`presenceSubscribe`** | A subscribe stanza with a tctoken per chat, only to stretch a debounce window | `Socket/chats.js` (**read**). **Cut.** |
| **Precomputed `linkPreview`** | A hand-crafted payload that is either thumbnail-less or needs a fetch anyway | `Utils/messages.js` (**read**). **Cut.** |
| **Editing or deleting the filler** | Shows an "Edited" label, or leaves a deleted tombstone | ghacks 2023 (**unverified**) |
| **Auto-splitting answers** | One notification per piece; interleaves with the user's double-texts | WAHA anti-blocking guidance |
| **URL shorteners** | Hide the canada.ca domain | IRCC protect-fraud page |
| **Installing `link-preview-js`** | A fetch on every send (up to 3 s more) | `Socket/messages-send.js` getUrlInfo |
| **Bursts after an outage** | An offline backlog or an outbox flush sends many answers back-to-back | Judgement call; applies to FIX-13 and FIX-21 |
| **A uniform per-turn rhythm** | The same sequence of events on every turn | Judgement call |
| **Any reply before the allowlist check** | Automated messages to strangers are the clearest automation signal and a privacy leak | `index.js` media nudge (**read**); FIX-40 |

---

## 5. Context and memory policy

**Verdict:** keep **little, structured, bounded** context. The quote is the strongest pointer. "Start over" must really forget. **Only what was actually sent enters context.**

### What lives in State

| Field | Content | Cleared by |
|---|---|---|
| `lastTurns` | ≤ 2 × {question, rewritten question, answer summary ≤ 400 chars, sent msg id}. **Written only after the answer is sent** (C4) | reset, start over, the 4 h context clock, a subject switch |
| `lastSources` | URLs of the last sent answer | same |
| `answerRemainder` | The rest of a long answer | the 4 h context clock, or a newer overflow (not "the next answer") |
| `pendingPrompt` | {kind, sent msg id, sent time}, for C15 binding and the C19 dedupe key | when it is answered |
| `lastAnsweredPrompt` | {kind, slot or choice, value}, for the C15 "sorry N" re-bind | the next answered prompt |
| `slots` | Intake answers, written via LangGraph **`Overwrite`** | reset, start over, synthesis done, the 7-day intake clock |
| `noMatchCount[slot]` | Escalation counter | slot advance |
| `remindersShown`, `disclaimerShown` | Tapering | the 4 h context clock |
| `pendingMessage` | Output buffer only | every turn, and the deferred reset (C4) |
| `caseFacts` (P2, parked) | Subject, status, programme | subject switch, start over |

**Kept in memory only, and lost on restart by design:**
- the last failed inbound `WAMessage` per chat (30 min TTL, for C11)
- a `key.id` LRU and a content-hash LRU (FIX-13, FIX-38)
- the module-scope outbox (FIX-21)

### Referent priority, per turn
1. **A quoted message.** For a question it is the referent. For a digit it is the prompt being answered (C15).
2. **A repair marker** (no / I meant / actually / what about / and / ignore that). If complaint words are present, C14 applies.
3. **Otherwise the message stands alone.**

### Rewrite gate (C13)
- Rewrite only when: the message is short, **or** it opens with a repair marker, **or** it has a pronoun with no noun, **or** it is a quote-reply.
- Show the interpretation as a heading ("📌 Study permit fees:"). This is implicit confirmation (Clark & Brennan 1991).
- The rewrite **drops personal details**, so it is also the safe Serper query (P15).
- Its latency on gpt-oss:20b is unmeasured (open question).

### Session boundary (C9)
- After a **4 h** gap, clear the context fields (judgement call).
- An **open intake** is kept for up to **7 days** (today's `STALE_MS`):
  - A slot-valid reply continues the intake.
  - An off-slot message gets the resume card: "Last time: PR check, 2 of 6 answered. Continue, or start fresh — or just ask."
- After 7 days the intake is cleared silently and the message is handled as fresh.

### Retention and privacy
- **The allowlist check runs before any log line that carries text** (today `[in]` logs first, **read**).
- Redact UCI, SIN and passport numbers at **ingress**.
- **Logs** hold ids and lengths, never message text.
- **Checkpoints** do hold text (the graph input). FIX-28 bounds them.
- **"forget me"** must be the **whole message**, and it is followed by an explicit confirm: "This deletes our whole chat history with me. Reply *yes, delete* to confirm". Only then is `deleteThread` called.
- Key threads on one canonical identity (P2, FIX-29).

---

## 6. Formatting contract and deterministic sanitizer

### Message layout (code-enforced)
1. **A 1–2 line direct answer** (BLUF), optionally under the implicit-confirm heading.
2. **≤ 5 bullets** (`• `). For a compound question, **one short section per sub-question** instead (≤ 2 bullets each, ≤ 3 sections).
3. **≤ 2 source lines**, rendered by code from `chunks[n].metadata.url`.
4. **Disclaimer:** a short fixed footer. The full version appears on the first answer and whenever `isHighStakes()`, with the licensed-consultant register link.
5. **Menu hint, tapered** (C10).
6. **Body cap ~900–1,000 chars** (judgement call). Overflow is stored, and the message ends "Want more? Reply *more*".

### Input dialect
- **The model writes standard Markdown.**
- SYSTEM_PROMPT drops the "WhatsApp bold is single asterisks" rule. It says instead: "Write plain Markdown; cite sources as [n]; do not write URLs."
- **Why:** a CommonMark lexer reads `*x*` as emphasis, so the old prompt and the lexer disagreed (platform-6). With one dialect, a compliant model and a non-compliant one both render correctly.

### Renderer rules (`marked` lexer → WhatsApp)

| Markdown token | Output |
|---|---|
| `strong` (`**x**`, `__x__`) | `*x*` |
| `em` (`*x*`, `_x_`) | `_x_` |
| `del` | `~x~` |
| `codespan` / code block | **Plain text.** Single-backtick and fenced rendering vary by client (**unverified** FAQ summary). |
| heading | `*Heading*` on its own line |
| bulleted list item | `• item` |
| **ordered list item** | `Step n: item`, never a bare leading digit, so a bare digit still means a choice |
| link `[t](u)` | `t: u`, then the URL rules below |
| table | `• col1 — col2`, one per row |
| html | stripped |

**Why `•` and not WhatsApp's native `* ` / `- ` lists:** the WhatsApp FAQ (**unverified** summary) says the newer list, quote and inline-code syntax works only on some clients. The literal `•` renders everywhere.

**Final regex pass:**
- trim spaces inside markers
- remove leftover unmatched `**` / `__`
- collapse 3+ newlines to 2

### URL rules (revised)
- Keep a URL **only if** it exactly matches a retrieved chunk URL **and** its host is `www.canada.ca`.
- **Sources are rendered by code**, always:
  - from the chunks the model cites as `[n]`, when it emits valid markers;
  - otherwise from the **top retrieved chunks** (≤ 2) by grade.
- **Abstaining on zero valid `[n]` is NOT enabled at launch.** It switches on only after open question 9 measures the `[n]` emission rate of gpt-oss:20b on `/v1/responses` over the 44-question eval, and that rate supports it (threshold: judgement call, set from the data). Otherwise a model that drops markers would turn correct answers into abstains.
- Count dropped URLs and answers with zero markers. Both counters are hallucination metrics, and the second one feeds open question 9.

---

## 7. Testing strategy and metrics

### Harness (FIX-01, built first)

| Layer | What | How |
|---|---|---|
| L1 graph fixtures | Conversations as JSON | `MemorySaver`; a `globalThis.fetch` mock for AI Search; `buildGraph(deps)` for the LLM |
| L2 transport | Bursts, edits, offline append, filler, presence, reconnect, allowlist, **outbound budget** | `handleTurn({graph, send, presence, now})` and `extractInbound(msg)`; a fake Baileys emitter; MockTimers. **Every fixture asserts the per-message outbound count** (§4), including 0 for a non-allowlisted sender. |
| L3 output oracle | Every reply | No `**`, no `#`, no `\|` tables, no line starting with a bare digit + `.`; URLs ⊆ retrieved ∩ allowlist; length ≤ cap; disclaimer present |
| L4 persistence | C1 mechanism, the `TimeoutPolicy` write-drop probe, retention | A scratch Postgres only, from a dedicated `IRCC_TEST_PG_URI`. The harness **refuses to start** if that variable is unset, or equals `RAGDB_URI` or the default `postgresql://mcp@127.0.0.1:5433/ragdb` (both read in `index.js` and `simulate.js`). |
| **L1/L2 gate-collision corpus** | A synthetic corpus of short, misspelled, prompt-context replies ("ok", 👍, "no", "2", "menu", "sorry 30", "haan", "hello??") at each prompt kind | Every gate enabled together (C17–C19, FIX-09, 12, 38, 39). Report a **false-positive count per gate class**. This is the weakest assumption's test (open question 21). |
| L5 exploratory (P2) | Confused, non-native, impatient and story-telling personas | openevals `runMultiturnSimulation`; agenda-based personas (Schatzmann 2007) |
| **L6 moderated walkthrough** (FIX-36) | 2–3 allowlisted relatives, on their own phones, with consent, given **synthetic** tasks | Think-aloud usability test (Nielsen 2000: a handful of users finds most problems). Run it **after FIX-07** (text-free logs, so relatives' messages never reach `~/Library/Logs`) and **before** the P1 turn-taking fixes (FIX-11, 12, 17) ship. It settles the debounce, the filler wording and the cap. |

**Hard rules:**
- The network mock throws on any non-stub host.
- **The Keychain path is stubbed:** tests inject the token through `CLOUDFLARE_AI_SEARCH_TOKEN`, a fake value, so `aisearch.js` never runs `/usr/bin/security` (read: the env var is checked before the Keychain).
- **`db.js persistChunk` is stubbed** in every test. The AI Search instance is shared, so an unstubbed write would land in it.
- No real chats, logs or `.env` are used.
- `simulate.js` stays a live smoke test, not CI. It checkpoints to `RAGDB_URI` and calls the live AI Search, Serper and LLM (read), so it is **never** used for L4.

### Metrics (PARADISE-style vector, Walker et al. 1997)
- **Task success**, **turns-to-answer**, **repair turns**.
- **Latency** p50/p95. **Time to read receipt < 3 s.** **Filler by ~4 s on RAG turns.**
- **Outbound events per inbound message** (gate: within the budget; 0 to non-allowlisted senders).
- **Format violations** and **ungrounded URLs** (gate: 0).
- **Zero-marker answers** (feeds open question 9).
- **Gate false positives per class** (from the collision corpus).
- **Prods per turn** (a count of "hello??"). It should fall if the filler works.
- **pass^k** over paraphrases (tau-bench), for L5.

### Gates
- CI fails on a format violation, an ungrounded URL, or an outbound budget overrun (the per-message budget in §4, exceptions included).
- CI fails if total repair turns go up.
- Red-then-green: each scenario must **fail on today's `main`** before its fix lands.
- **Regression guards are the exception:** S54 (dedupe scope) and the S40 Devanagari turn describe behaviour that is correct today. They must pass **before and after** their fix.

### Landing order (from the advisor review)
1. FIX-01 harness, with the L4 scratch-DB guard.
2. FIX-40 allowlist at ingress.
3. FIX-07 before FIX-36 (L6).
4. Probe `TimeoutPolicy` write-dropping (open question 20) before building FIX-03's pre-turn rollback. It may merge FIX-03 and FIX-37 into one mechanism.
5. FIX-11's read receipt only after open question 15.
6. FIX-16 before FIX-12's correction-rewrite path. Until then S21 asserts only the never-sent half.

---

## 8. Open questions

1. **PostgresSaver after a node throws.** Do the MemorySaver results hold? Re-run on a scratch DB (`IRCC_TEST_PG_URI`) before FIX-03. This also gates FIX-37 (abort + rollback).
2. **Disappearing-mode wire format** (inferred).
3. **Serper's 32-word cutoff** (inferred).
4. **LangSmith egress** (not checked).
5. **Corpus pollution from "thanks"** (inferred).
6. **Judgement-call numbers:**
   - debounce 2.5 s / 8 s
   - context clock 4 h
   - length cap ~900–1,000 chars
   - content-dedupe window 10 min
   - the meaningful-edit threshold
   - a compound-split limit of 3

   L6 and synthetic data settle them.
7. **Reaction notifications.** Secondary sources disagree on the default. This is moot unless a reaction is reconsidered.
8. **Rewrite latency on gpt-oss:20b.**
9. **How reliably gpt-oss:20b emits `[n]` markers and the ANSWERABLE flag** on `/v1/responses`, measured on the 44-question eval. This gates the zero-citation abstain rule (§6) and FIX-19. Fallback: `/v1/chat/completions` with `response_format`.
10. **Recognizers-Text on "2 or 3 years"** (probe first).
11. **Edits re-notifying** (secondary sources only).
12. **Answer-language policy, voice transcription and letter OCR** are operator decisions, kept at P2.
13. **The 2019 whitepaper's 75% figure** (unverified).
14. **Ashktorab 2019's ranking** (taken from the abstract and summaries).
15. **Is the bot account's read-receipt privacy set to `all`?** If not, `readMessages` sends `read-self` and the user sees no blue ticks, so FIX-11 leaves it off.
16. **Does the process exit after `MAX_RECONNECT_ATTEMPTS`, and does launchd restart it?** (inferred). The answer decides whether the accepted outbox loss (FIX-21) lasts a minute or forever.
17. **How often does `@lid` resolution fail** for allowlisted contacts? Count the operator alerts (FIX-35).
18. **Accuracy of the heuristic compound splitter** on synthetic questions.
19. **Romanized non-English messages** ("mera visa kab aayega"). They keep today's RAG path. Measure retrieval quality on synthetic samples before any special handling.
20. **Does `TimeoutPolicy` drop a timed-out node's writes on PostgresSaver**, as its doc says (read), and does that leave the thread at the pre-turn checkpoint? Probe this on the scratch DB. It is cheaper than question 1 and may answer it.
21. **Gate false-positive rate** per class on the collision corpus (§7). This is the weakest assumption.
22. **Cross-lingual retrieval on qwen3-embedding-0.6b.** The bot's threshold probe was English-only (`graph.js` comment, read). The model card's multilingual claim is **unverified** here. Run a synthetic non-English probe before FIX-32 adds any language-specific route.
23. **Can an informal citizenship check continue with an estimate**, labelled as an estimate and giving no verdict? Or must it stop at the calculator? Operator decision; it cuts against user-7, so the spec keeps "stop and link" until it is decided.
24. **Does a `NodeTimeoutError` reach `retryOn`**, so C3's exclusion works? (inferred; L1 asserts it).

---

## Red-team review

**39 objections: 27 accepted, 12 changed, 0 rejected.**
- **None rejected outright.** Several rested on unverified premises, but their conclusions held against the code or a fetched source. Those became "changed", with the premise corrected.
- **Fixes without a scenario** are P2, parked, or process-only: FIX-24–27, 29, 31–33, 36 and 37. Each gets a scenario before it is built.

| Cluster | Objections | Outcome |
|---|---|---|
| **Wait signal** | user-10, user-11, platform-1, platform-2, platform-3, platform-7, platform-11 | C5 rewritten: no ⏳ and no 20 s status, one explanatory filler, a counted per-message budget (+1 read receipt, with named exceptions). `markOnlineOnConnect` stays at its default, there is no jitter, and the ban column is now a count. |
| **Mid-flight correction and control** | user-1, platform-8 | C4 rewritten as hold-and-supersede. The withdrawn answer is never sent, and its timers are cancelled. The correction gets an ack, and the merged turn carries the withdrawn text. Control messages get a static fast reply. Abort + rollback is deferred to FIX-37, behind open questions 1 and 20. |
| **Reset matching** | user-2, user-14 | C8 rewritten: normalise first, then match the whole message. `cancel` matches only as the whole message, at intake. |
| **Session clocks** | user-3 | C9: two clocks (4 h context, 7-day intake). A slot-valid reply after a gap is accepted. |
| **Offline backlog** | user-4, platform-14, platform-5 | Beyond the window, one coalesced note per chat. An explicit append predicate, and an in-memory LRU for dedupe. |
| **Language floor** | user-5 | **Revised in revision 3 (advisor must-change 5):** the P0 floor is the multilingual yes/no lexicon at prompts only (FIX-08). The non-Latin "English-only" line is dropped, because today's path already answers in English with an acknowledgement. Translation stays P2 (FIX-32). |
| **Complaint + correction** | user-6 | C14: new content wins. |
| **Citizenship estimates** | user-7 | C7: never convert an estimate to days; link the official calculator; the prompt stops inviting estimates. |
| **New edge cases** | user-8, 9, 12, 13, 17, 18, 19, 22, 23 | New scenarios S40–S51 and FIX-34, 35, 38, 39. user-17's premise is corrected: `routeFromStart` sends anything over 12 chars to RAG, so a story gets a generic answer, not the menu. |
| **Choice binding** | user-15 | C15: a quoted digit binds to the quoted prompt; a digit older than the current prompt gets a confirm; more choices use words. |
| **Edits** | user-16, platform-10 | One edit path (`messages.update`). Re-answer only on a meaningful change. |
| **Formatting** | platform-6, user-20, platform-15 | Markdown input dialect; "Step n:"; codespans as plain text; `•` kept, with the reason stated. |
| **Keyword tolerance** | user-21 | Tolerant *more* and *again*. The remainder lives on the 4 h clock. |
| **Quoting needs content** | platform-4 | C11: quote only with a `WAMessage` in hand. A 30 min in-memory slot for the last failed message; no inbound store. |
| **Scope** | platform-9, platform-12, platform-13 | presenceSubscribe and linkPreview cut. FIX-24/25/27/31 parked. The Avoid citation is fixed. The outbox loss is accepted explicitly, with one coalesced flush. |
| **Real-user validation** | user-24 | L6 moderated walkthrough (FIX-36) before the P1 turn-taking changes ship, and after FIX-07. |

### Weakest remaining assumption
- **The stacked deterministic gates misfire less than today's single `length > 12` rule** on short, broken, non-native English. The stack is FIX-09's classes, C17's bypass, C19's dedupe, FIX-39's scam markers, C8, C14 and C15.
- **Why it matters:** every misfire produces silence, a canned line or a misbound choice. Silence is problem #1.
- **What settles it:** the per-gate-class false-positive count on the collision corpus (§7, open question 21), with every gate enabled together.
- **Second weakest:** hold-and-supersede is assumed cheap enough. The user still waits for the withdrawn run (~27 s) before the corrected answer: about 54 s in the worst case. After the instant static menu (S06, S22), the next message queues behind the held run, for up to the 120 s deadline. The ack line and static reply cover the gap; FIX-37 recovers the time once rollback is proven.

### Known residual (user-5)
- Romanized Hindi, Punjabi and Tagalog free text keeps today's RAG path, whose cross-lingual quality is unmeasured (open questions 19 and 22).
- Only the small yes/no lexicon handles them at prompts.

---

## Advisor review

**6 must-changes: all 6 verified against the code and applied.** Three collided with existing scenarios; each collision is resolved below.

| # | Must-change | Verified? | What I did |
|---|---|---|---|
| 1 | **Allowlist at ingress**, before the media nudge and any send, error reply included | **Yes (read).** `index.js messages.upsert` media nudge calls `sock.sendMessage` with no `isAllowed`. The `processMessage` catch replies even when `isAllowed` threw. The `[in]` log line runs before the check. | New **P0** principle and **FIX-40 (P0, S)**. A throw in `isAllowed` means no reply, a text-free error log, and the FIX-35 operator alert, so a relative is not silently dropped. Verdict #1, §3, §4 budget (0 events to strangers) and §5 updated. FIX-13, 23, 35 and 39 now depend on FIX-40. New **S52** (fails on today's `main`). |
| 2 | **Scope FIX-38** to free-text RAG question turns, keyed on text plus pending-prompt id | **Yes (logic, checked against S02, S14, S16, S28).** | New **C19**; P9, FIX-38, the catalogue row and S45 updated. New regression guard **S54** (passes before and after, stated in §7). |
| 3 | **Buffer bypass in FIX-12** for full parses, control verbs and prods | **Yes (logic, against S16/S17/S37 and the < 3 s metric).** | New **C17**. **Collision with S20** (which buffered "1" so "sorry 2" could win): S20 now dispatches "1" at once, and "sorry 2" re-binds the last answered prompt (C15 extension, `lastAnsweredPrompt` in §5, judgement call). S16 asserts no buffer delay. |
| 4 | **Gate order in FIX-09:** pending-prompt parse before dialogue-act classes | **Yes (read).** `YES_WORDS` has no "ok" or 👍, so today they are no-matches at a yes/no prompt. | New **P18 / C18** with the full order: control verbs (C8), then the pending-prompt parse (including the C15 confirm), then the classes, then RAG. S17's 👍 and S34's "ok" still pass, because no yes/no prompt is pending there. New **S53** (fails on today's `main`). C14 now applies only when no prompt is pending. |
| 5 | **Drop the P0 non-Latin "English-only line"** until the cross-lingual probe | **Partly.** `llm.js SYSTEM_PROMPT` already answers non-English questions in English, with an acknowledgement (**read**). The "multilingual embedding" premise is **unverified**: the code names qwen3-embedding-0.6b, but its threshold probe was English-only (`graph.js` comment). The conclusion stands on the read part alone. | P17 rewritten. The rule is removed from FIX-09, S40 and the catalogue row. The yes/no lexicon stays at P0 (FIX-08). The script line moves to FIX-32 (P2), gated on open question 22. S40's Devanagari turn asserts "handled as today, no canned line" (a regression guard). The user-5 note is amended, and its disposition is kept. |
| 6 | **Decouple the zero-`[n]` abstain rule from P0** | **Yes (logic).** Open question 9 is unmeasured. | §6 URL rules: code always renders the sources, from the cited chunks or else the top retrieved chunks. Abstain-on-zero-markers is off until open question 9 is measured. FIX-04, FIX-19 and open question 9 updated. New metric: zero-marker answers. |

**Also addressed** (from the advisor's `missing` and `ordering_issues`; each one read myself):
- **Native LangGraph timeouts (read, 1.4.12):** P10 and FIX-03 now use the node `timeout`, with the node's signal still threaded into `fetch` and the OpenAI call, because cancellation is cooperative (read). Whether a node timeout fully covers a per-turn deadline is **inferred**.
- **Retry × deadline (read: the timer resets per retry; `retryOn` exists):** C3 excludes `NodeTimeoutError` via `retryOn`. That it reaches `retryOn` is inferred (open question 24).
- **S01 vs C10/S35:** S01 now expects the tapered one-line menu hint on the first answer, aligned to C10.
- **`GREETING_TEXT` (read):** added to FIX-02.
- **`yearsPresent` prompt "A rough number is fine" (read):** C7/FIX-08 change the copy only. Continuing with an estimate is open question 23.
- **Redirect bypass (read: `fetchPageText` never checks `res.url`):** C12 and FIX-06 re-check the final URL. New **S55**.
- **Deferred reset mechanics:** C4 now suppresses the graph's own menu reply and clears `pendingMessage` (inferred; asserted in L1).
- **"RAG turns only" filler:** C5 names the mechanism (a `streamMode: "custom"` retrieval event) and the 4 s-timer fallback.
- **Harness gaps (read):** the Keychain path is stubbed through `CLOUDFLARE_AI_SEARCH_TOKEN`, and `persistChunk` is stubbed. L4 requires `IRCC_TEST_PG_URI` and refuses `RAGDB_URI` or the default URI. `simulate.js` is never used for L4.
- **Ordering:** a landing order was added to §7. FIX-07 comes before FIX-36. The read receipt waits on open question 15. FIX-16 comes before FIX-12's rewrite path. The `TimeoutPolicy` probe comes before FIX-03's rollback.
- **Weakest assumption:** adopted as the spec's own (gate collisions), with the collision corpus as its test.
