import { parseControl } from "./control.js";
import { StateGraph, Annotation, interrupt, Command, START, END } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { retrieve, topSimilarity } from "./db.js";
import { isHighStakes, synthesize } from "./llm.js";
import { isMoreRequest, layoutAnswer, nextChunk } from "./layout.js";
import { webFallback, persistWebFallback } from "./websearch.js";
import { renderAnswer } from "./render.js";
import { SOURCES_NONE, classifyAct, isComplaintWithContent, isShortQuestion } from "./gate.js";

// Everything that leaves the process (retrieval, web fallback, the LLM). buildGraph(deps)
// takes overrides so the offline dialogue harness (test/dialogue/) runs with stubs:
// docs/conversation-design.md FIX-01.
const DEFAULT_DEPS = { retrieve, topSimilarity, synthesize, webFallback, persistWebFallback };

// FIX-03: a transient failure (AI Search 500, a dropped connection) is retried once,
// silently, at the node. A deadline (AbortError/TimeoutError) is NOT retried: the user has
// already waited the full budget. LangGraph RetryPolicy (pregel/utils).
export const RAG_RETRY = {
  maxAttempts: 2,
  initialInterval: 500,
  retryOn: (e) => !["AbortError", "TimeoutError"].includes(e?.name) && !/timed? ?out/i.test(String(e?.message ?? "")),
  logWarning: false,
};

// Progressive disclosure, two short steps instead of one 6-option list —
// W3C COGA guidance on impaired working memory (1-3 items, stricter than
// the classic "7+-2") for anyone deciding under attention/focus difficulty.
const MENU_OPTIONS_TEXT =
  "What are you hoping to do?\n" +
  "1) Visit or stay temporarily (visit, study, or work)\n" +
  "2) Settle in Canada long-term (permanent residence or citizenship)\n" +
  "3) Something else / just ask a question\n\n" +
  "Reply with a number, or just type your question any time.";

const MENU_TEXT =
  "Hi! I'm a helper bot (not IRCC, not a person) for questions about coming to Canada. I answer from public canada.ca pages.\n\n" +
  MENU_OPTIONS_TEXT;

const MENU_SHORT_REMINDER =
  "Want to explore a specific path? Reply with a number:\n" +
  "1) Visit/study/work  2) Settle permanently or citizenship  3) Ask anything else";

const TEMP_PROMPT_TEXT = "Got it — which one?\n1) Visit\n2) Study\n3) Work";
const SETTLE_PROMPT_TEXT =
  "Got it — which one?\n1) Settle permanently (PR / Express Entry)\n2) Become a Canadian citizen";

// FIX-15 (C8): control words are normalised, then matched against the WHOLE message (src/control.js).
// The old rule matched "reset" anywhere in 30 characters, so "reset my GCKey password" showed the menu.
const isResetCommand = (text, opts) => !!parseControl(text ?? "", opts);

// Slot answers come from someone who isn't very technical — a stray period,
// extra space, or writing the number as a word shouldn't count as "invalid".
const NUMBER_WORDS = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
function normalizeChoice(text) {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  return NUMBER_WORDS[t] ?? t;
}

// FIX-08: a small multilingual yes/no lexicon (P17 language floor; judgement call, measured by
// the FIX-01 collision corpus). "ok" and 👍 count as yes ONLY here, at a yes/no prompt (P18:
// the pending prompt binds before any dialogue-act class).
const YES_WORDS = new Set([
  "y", "yes", "yeah", "yep", "ya", "yup", "yes please", "ok", "okay", "k", "sure", "correct", "right",
  "👍", "✅", "✔️", "haan", "han", "ha", "ji", "haan ji", "हाँ", "हां", "si", "sí", "oui", "ja", "da",
]);
const NO_WORDS = new Set(["n", "no", "nope", "nah", "not really", "never", "👎", "❌", "nahi", "nahin", "nai", "नहीं", "non", "nein"]);
function parseYesNo(text) {
  const t = text.trim().toLowerCase().replace(/[.!?,]+$/, "").replace(/\s+/g, " ");
  if (YES_WORDS.has(t)) return "yes";
  if (NO_WORDS.has(t)) return "no";
  return null;
}

// FIX-08: days in Canada must be an exact count. An estimate ("about 3 years", "2 or 3 years")
// is never turned into days: "2 or 3 years" used to become 23 days, and rounding a guess onto
// the 1,095-day legal threshold would mislead. The official calculator gives the real number.
const PRESENCE_CALCULATOR_URL =
  "https://www.canada.ca/en/immigration-refugees-citizenship/services/canadian-citizenship/adult-minor/how/physical-presence.html";
const ESTIMATE_REPROMPT =
  "I need the exact number of days, not an estimate, because the rule is a precise count. " +
  `IRCC's physical presence calculator works it out for you: ${PRESENCE_CALCULATOR_URL}`;
function parseDaysPresent(text) {
  const t = text.trim().toLowerCase();
  if (/\b(not sure|don'?t know|dont know|idk|no idea|unsure)\b/.test(t)) return { reprompt: ESTIMATE_REPROMPT };
  const exact = t.match(/^(\d{1,3}(?:,\d{3})+|\d+)\s*(?:days?)?$/);
  if (exact) {
    const n = Number(exact[1].replace(/,/g, ""));
    return Number.isInteger(n) && n >= 0 && n <= 1826 ? n : null; // at most 5 years of days
  }
  if (/\d/.test(t) && /\b(years?|yrs?|months?|weeks?|about|around|approx\w*|roughly|maybe|almost|nearly|or|to)\b|~|-/.test(t)) {
    return { reprompt: ESTIMATE_REPROMPT };
  }
  return null;
}

// --- branch definitions ---------------------------------------------------

const TOPIC_BRANCHES = {
  1: { label: "visiting Canada", sources: ["ircc-crawl-visit"] },
  2: { label: "studying in Canada", sources: ["ircc-crawl-study"] },
  3: { label: "working in Canada", sources: ["ircc-crawl-work"] },
};

const PR_SLOTS = [
  {
    key: "age",
    label: "age",
    hint: "Just the number, like 34.",
    prompt: "How old are you? (just the number)",
    parse: (t) => {
      const n = parseInt(t, 10);
      return Number.isInteger(n) && n >= 15 && n <= 100 ? n : null;
    },
    describe: (v) => `age ${v}`,
  },
  {
    key: "education",
    label: "education",
    hint: "Just the number from the list, 1 to 7.",
    prompt:
      "What's your highest level of education?\n" +
      "1) High school or less\n" +
      "2) 1-year college/trade diploma\n" +
      "3) 2-year college/trade diploma\n" +
      "4) Bachelor's degree\n" +
      "5) Two or more degrees (one 3+ years)\n" +
      "6) Master's or professional degree\n" +
      "7) PhD",
    parse: (t) => {
      const map = {
        1: "high school or less",
        2: "1-year college/trade diploma",
        3: "2-year college/trade diploma",
        4: "Bachelor's degree",
        5: "two or more degrees (one 3+ years)",
        6: "Master's or professional degree",
        7: "PhD",
      };
      return map[normalizeChoice(t)] ?? null;
    },
    describe: (v) => `education: ${v}`,
  },
  {
    key: "language",
    label: "English or French level",
    hint: "Just the number from the list, 1 to 4.",
    prompt:
      "How would you rate your English or French?\n" +
      "1) Just starting out\n" +
      "2) Basic everyday conversation\n" +
      "3) Comfortable in daily life and work\n" +
      "4) Very strong / fluent",
    parse: (t) => {
      const map = {
        1: "just starting out",
        2: "basic everyday conversation",
        3: "comfortable in daily life and work",
        4: "very strong / fluent",
      };
      return map[normalizeChoice(t)] ?? null;
    },
    describe: (v) => `self-rated language ability: ${v} (not a formal test score)`,
  },
  {
    key: "workYears",
    label: "skilled work experience",
    hint: "Just the number from the list, 1 to 4.",
    prompt:
      "How many years of skilled work experience do you have?\n" +
      "1) Less than 1 year\n" +
      "2) 1-2 years\n" +
      "3) 3-5 years\n" +
      "4) 6 or more years",
    parse: (t) => {
      const map = { 1: "less than 1 year", 2: "1-2 years", 3: "3-5 years", 4: "6+ years" };
      return map[normalizeChoice(t)] ?? null;
    },
    describe: (v) => `skilled work experience: ${v}`,
  },
  {
    key: "canadianExperience",
    label: "worked in Canada",
    hint: "Just yes or no.",
    prompt: "Have you ever worked inside Canada? Reply yes or no.",
    parse: parseYesNo,
    describe: (v) => `Canadian work experience: ${v}`,
  },
  {
    key: "jobOfferOrPN",
    label: "job offer or provincial nomination",
    hint: "Just yes or no.",
    prompt:
      "Do you have a valid job offer from a Canadian employer, or a provincial nomination? Reply yes or no.",
    parse: parseYesNo,
    describe: (v) => `job offer or provincial nomination: ${v}`,
  },
];

const CITIZENSHIP_SLOTS = [
  {
    key: "prStatus",
    label: "PR status",
    hint: "Just yes or no.",
    prompt: "Do you currently have valid Canadian permanent resident (PR) status? Reply yes or no.",
    parse: parseYesNo,
    describe: (v) => `has PR status: ${v}`,
  },
  {
    key: "yearsPresent",
    label: "days in Canada (last 5 years)",
    hint: "Just the number of days, like 900, or say *not sure*.",
    prompt:
      "How many days have you been physically present in Canada in the last 5 years? " +
      "Reply with the exact number of days (IRCC's physical presence calculator counts them: " +
      `${PRESENCE_CALCULATOR_URL} ), or say *not sure*.`,
    parse: parseDaysPresent,
    describe: (v) => `${v} days physically present in Canada in the last 5 years`,
  },
  {
    key: "taxYears",
    label: "years of taxes filed (last 5)",
    hint: "Just a number from 0 to 5.",
    prompt: "In how many of the last 5 years did you file Canadian income taxes? (0-5)",
    parse: (t) => {
      const n = parseInt(t, 10);
      return Number.isInteger(n) && n >= 0 && n <= 5 ? n : null;
    },
    describe: (v) => `filed taxes in ${v} of the last 5 years`,
  },
  {
    key: "age",
    label: "age",
    hint: "Just the number, like 34.",
    prompt: "How old are you? (just the number)",
    parse: (t) => {
      const n = parseInt(t, 10);
      return Number.isInteger(n) && n >= 10 && n <= 100 ? n : null;
    },
    describe: (v) => `age ${v}`,
  },
];

const BRANCH_SLOTS = { 4: PR_SLOTS, 5: CITIZENSHIP_SLOTS };
const BRANCH_SOURCES = { 4: ["ircc-crawl-pr"], 5: ["ircc-crawl-citizenship"] };
// Profile-free retrieval for the intake summary (FIX-07, S13): the search sees only the topic.
const BRANCH_RETRIEVAL_QUERY = {
  4: "Express Entry eligibility and how the Comprehensive Ranking System scores applicants",
  5: "Canadian citizenship eligibility: physical presence days, income tax filing, language ability and the citizenship test",
};

function looksLikeRealQuestion(text) {
  // FIX-09: short questions and acronyms ("PGWP?", "eTA") are questions too; non-questions
  // never get here (classifyAct runs first at menu level).
  const t = text.trim();
  return t.length > 12 || isShortQuestion(t);
}

// CRAG-style grading, simplified: real CRAG grades each doc via an LLM into
// correct/incorrect/ambiguous. Here the grade is the best vector (cosine)
// similarity among the retrieved chunks — not chunks[0]'s, because the store
// ranks by a hybrid fused score and its top hit can be keyword-only, with no
// vector score at all — against a stricter threshold than db.js's own
// SIMILARITY_FLOOR (0.45, which just filters noise).
//
// 0.60, re-tuned 2026-11-19 on AI Search's qwen3-embedding-0.6b with
// scripts/threshold-probe.mjs (44 synthetic questions): every covered question
// whose best chunk was the right page scored >= 0.613 (18/18 kept), off-topic
// questions topped out at 0.570 bar one outlier (0.637), and the two covered
// questions that hit the WRONG page scored 0.554 and 0.450, so they now go live.
// The old 0.5 let 5 of 14 off-topic questions through. 0.65 was rejected: it would
// send 3 correctly covered questions (0.613-0.635) to a needless live search.
// Weakest assumption: the probe is English and well-formed; real messages score
// lower, which costs extra live searches rather than wrong answers.
// Below GRADE_THRESHOLD, retrieval is treated as "incorrect" and discarded
// in favor of a canada.ca-scoped live search, same as CRAG's incorrect branch. This trades grading
// precision for zero extra latency (an LLM grading call would stack with
// the already-slow synthesis call).
const GRADE_THRESHOLD = 0.6;

// Lay wording for lost status ("my status expired", "I overstayed") retrieved only general visitor
// pages, while "how do I restore my status" ranked IRCC's restoration pages first (measured
// 2026-11-20). Lexical query expansion (a standard IR technique) adds the official terms to the
// RETRIEVAL query only; the model still answers the user's own words. None of the 44 eval
// questions match, so their retrieval is unchanged.
const LOST_STATUS_RE = /\b(?:overstay(?:ed|ing)?|out of status|lost (?:my |our |his |her |their )?status|status (?:has |had |is |was )?(?:expired|ended|run out|ran out)|expired (?:status|visa|permit|study permit|work permit|visitor record)|(?:visa|permit|visitor record) (?:has |had |is |was )?(?:expired|ended))\b/i;
const RESTORATION_TERMS = "restore status restoration 90 days";
export function expandRetrievalQuery(question) {
  return LOST_STATUS_RE.test(question ?? "") ? `${question} ${RESTORATION_TERMS}` : question;
}

function makeAnswerFreeform({ retrieve, topSimilarity, synthesize, webFallback, persistWebFallback }) {
  // `retrievalQuery` (FIX-07): what goes to AI Search and Serper. Defaults to the question;
  // the intake summary passes a generic query so the user's profile only reaches the LOCAL model.
  return async function answerFreeform(question, sources = null, { retrievalQuery = expandRetrievalQuery(question), tier = "short", after = null } = {}) {
  let chunks = await retrieve(retrievalQuery, { sources });
  const gradedWell = topSimilarity(chunks) >= GRADE_THRESHOLD;

  if (!gradedWell) {
    const webChunks = await webFallback(retrievalQuery);
    if (webChunks.length > 0) {
      chunks = webChunks; // discard local — CRAG's "incorrect" branch, not a blend
      persistWebFallback(webChunks).catch((err) =>
        console.error("Background persistWebFallback failed:", err)
      );
    }
    // If web fallback also came up empty, fall through with the original
    // (possibly empty) local chunks — synthesize() gives an honest "don't
    // know" rather than guessing.
  }

  // FIX-04: code, not the model, owns WhatsApp formatting and the source links.
  // FIX-22: the sources travel with the text, so "show me the page" can answer from them.
  // FIX-18: code owns the layout too — body cap above WhatsApp's fold, tiered disclaimer, overflow.
  const rendered = renderAnswer(await synthesize(question, chunks), chunks);
  const { text, remainder } = layoutAnswer({ body: rendered.body, sources: rendered.sources, tier, after });
  return { text, sources: rendered.sources, remainder };
  };
}

// --- graph state ------------------------------------------------------------
//
// Deliberately no I/O side effects (no sending messages) inside any node —
// on resume-after-crash, LangGraph re-executes a node from its top, replaying
// only up to the point of its interrupt() calls. retrieve()/synthesize() are
// safe to redo (idempotent reads/LLM calls); sending a WhatsApp message is
// NOT, so that only ever happens in index.js, driven by this graph's output.

const State = Annotation.Root({
  incomingText: Annotation({ default: () => "" }),
  pendingMessage: Annotation({ default: () => null }),
  started: Annotation({ default: () => false }),
  branch: Annotation({ default: () => null }),
  slotIndex: Annotation({ default: () => 0 }),
  // A merge reducer can never REMOVE a key, so `slots: {}` on reset cleared nothing (measured):
  // CLEAR_SLOTS is an explicit "empty it" update (FIX-08).
  slots: Annotation({
    reducer: (left, right) => (right && right.__clear ? {} : { ...left, ...right }),
    default: () => ({}),
  }),
  // Not returned by resetNode, so a "menu"/reset command never re-triggers
  // it — this is specifically the very first message on this thread ever,
  // not "the start of the current conversation".
  hasGreeted: Annotation({ default: () => false }),
  // FIX-09: the next menu interrupt sends pendingMessage as-is (no menu reminder); "" = silence.
  bareReply: Annotation({ default: () => false }),
  // FIX-22: the canada.ca pages behind the last answer, for "show me the page".
  lastSources: Annotation({ default: () => [] }),
  // FIX-15: consecutive no-matches at the current intake prompt (S28), and whether the last
  // intake turn answered a side question and now waits for "continue or stop?" (S29).
  noMatch: Annotation({ default: () => 0 }),
  awaitingContinue: Annotation({ default: () => false }),
  // FIX-15b: which recap item is being changed (0-based), or null.
  editingSlot: Annotation({ default: () => null }),
  // FIX-18 (C9/C10): the last answer's overflow for "more" ({ text, at }), and when the full
  // disclaimer and the menu hint were last shown — each re-shown after a 4 h session gap.
  answerRemainder: Annotation({ default: () => null }),
  disclaimerAt: Annotation({ default: () => 0 }),
  hintShownAt: Annotation({ default: () => 0 }),
});

// No yes/no framing ("...do you?") — a closed question invites a
// confirmatory reply ("Yes, what should I do?") long enough to trip
// looksLikeRealQuestion in routeFromStart below and get misrouted into
// quickAnswer's RAG path instead of the menu. Lead straight into the
// numbered menu instead, same as MENU_TEXT, so the very first message
// already tells her exactly how to reply.
const GREETING_TEXT =
  "Hey dear 👋🏽, I'm Izzy's Minion 🤓 — a helper bot (not IRCC, not a person) for questions about coming to Canada. I answer from public canada.ca pages.\n\n" +
  MENU_OPTIONS_TEXT;

// --- nodes -------------------------------------------------------------------

const CLEAR_SLOTS = { __clear: true };

// FIX-15: what each intake is called when it is stopped ("Okay, stopping the PR check.").
const CHECK_LABEL = { 4: "PR check", 5: "citizenship check" };
const atIntake = (state) => !!BRANCH_SLOTS[state.branch];

// A reset clears the intake AND the referent context (S32). `cancel` at an intake says what it
// stopped; an anchored phrase's remainder ("start over, I want to ask about…") is answered next.
function resetNode(state) {
  const control = parseControl(state.incomingText ?? "", { atIntake: atIntake(state) });
  const stopped = control?.verb === "cancel" && CHECK_LABEL[state.branch];
  return {
    pendingMessage: stopped ? `Okay, stopping the ${stopped}.` : null,
    incomingText: control?.rest ?? "",
    started: false,
    branch: null,
    slotIndex: 0,
    slots: CLEAR_SLOTS,
    lastSources: [],
    noMatch: 0,
    awaitingContinue: false,
    editingSlot: null,
    answerRemainder: null,
    bareReply: false,
  };
}
// The remainder goes through the same gate as any message: "never mind, thanks" is a closing.
function routeFromReset(state) {
  const rest = state.incomingText ?? "";
  if (!rest) return "menu";
  if (classifyAct(rest)) return "smallTalk";
  return looksLikeRealQuestion(rest) ? "quickAnswer" : "menu";
}

function entryNode() {
  return {}; // pass-through; routing happens in the conditional edge below
}

function greetingNode() {
  const text = interrupt(GREETING_TEXT);
  // Her reply feeds straight into the normal entry routing (a real
  // question gets answered directly, a short "yeah"/whatever shows the
  // menu) — no special-casing needed here.
  return { incomingText: text, hasGreeted: true };
}

// FIX-18 (C9, C10): a session is a 4 h window (judgement call).
const SESSION_MS = 4 * 60 * 60 * 1000;
const fresh = (at) => !!at && Date.now() - at <= SESSION_MS;
/** Disclaimer tier for an answer: strong for high stakes, full once per session, else short. */
const tierFor = (state, question) => (isHighStakes(question ?? "") ? "strong" : fresh(state.disclaimerAt) ? "short" : "full");
/** State updates after an answer: its sources, the disclaimer clock, and any overflow for "more". */
function answered(result, tier) {
  const u = { lastSources: result.sources };
  if (tier !== "short") u.disclaimerAt = Date.now();
  if (result.remainder) u.answerRemainder = { text: result.remainder, at: Date.now() };
  return u;
}

function menuNode(state) {
  // C10: the one-line menu hint is tapered — first answer of a session only.
  const showHint = !!state.pendingMessage && !state.bareReply && !fresh(state.hintShownAt);
  const text = interrupt(
    state.bareReply
      ? (state.pendingMessage ?? "")
      : state.pendingMessage
        ? showHint
          ? `${state.pendingMessage}\n\n${MENU_SHORT_REMINDER}`
          : state.pendingMessage
        : MENU_TEXT
  );
  return { incomingText: text, pendingMessage: null, bareReply: false, started: true, ...(showHint ? { hintShownAt: Date.now() } : {}) };
}

// FIX-18 (S35): "more" sends the stored overflow of the last long answer; no new search.
const NOTHING_MORE = "That's everything I had on that. Ask me anything else.";
function moreNode(state) {
  const rem = state.answerRemainder;
  if (!rem?.text || !fresh(rem.at)) return { pendingMessage: NOTHING_MORE, bareReply: true, answerRemainder: null };
  const { text, remainder } = nextChunk(rem.text);
  return { pendingMessage: text, bareReply: true, answerRemainder: remainder ? { text: remainder, at: rem.at } : null };
}

// FIX-09: an instant fixed reply (or silence) for a recognised dialogue act; no retrieval, no LLM.
function smallTalkNode(state) {
  const act = classifyAct(state.incomingText ?? "");
  // FIX-22: "show me the page" answers from the last answer's sources, never from a new search.
  if (act?.kind === "sources") {
    const urls = state.lastSources ?? [];
    const reply = urls.length ? `Here's the official page I used:\n${urls.map((u) => `🔗 ${u}`).join("\n")}` : SOURCES_NONE;
    return { pendingMessage: reply, bareReply: true, hasGreeted: true };
  }
  return { pendingMessage: act?.reply ?? "", bareReply: true, hasGreeted: true };
}

// FIX-02: a chat that OPENS with a real question gets the answer at once, introduced by one
// identity line (a bot, not IRCC, not a person: P16; California SB 1001 / EU AI Act Art. 50 as
// precedent) instead of a greeting that ignores the question (conditional relevance, Schegloff 1968).
const INTRO_LINE = "👋🏽 I'm Izzy's Minion 🤓, a helper bot (not IRCC, not a person). I answer from public canada.ca pages.";

const quickAnswerNode = (answerFreeform) => async function quickAnswerNode(state) {
  const tier = tierFor(state, state.incomingText);
  const result = await answerFreeform(state.incomingText, null, { tier });
  // FIX-22 (C14): a complaint that still carries content is answered, opening with an apology.
  const answer = isComplaintWithContent(state.incomingText) ? `Sorry about that — ${result.text}` : result.text;
  const pendingMessage = state.hasGreeted ? answer : `${INTRO_LINE}\n\n${answer}`;
  return { pendingMessage, hasGreeted: true, ...answered(result, tier) };
};

function topicPromptNode(state) {
  const branch = TOPIC_BRANCHES[state.branch];
  const text = interrupt(`Sure — what would you like to know about ${branch.label}? Ask anything, in your own words.`);
  return { incomingText: text };
}

const topicAnswerNode = (answerFreeform) => async function topicAnswerNode(state) {
  const branch = TOPIC_BRANCHES[state.branch];
  const tier = tierFor(state, state.incomingText);
  const result = await answerFreeform(state.incomingText, branch.sources, { tier });
  return { pendingMessage: result.text, branch: null, ...answered(result, tier) };
};

function freeformPromptNode(state) {
  const text = interrupt("Go ahead, ask me anything about coming to Canada.");
  return { incomingText: text };
}

// Progressive disclosure: level 1 (menu) only asks a 3-way split; these two
// nodes ask the follow-up narrowing question. Each translates its own local
// 1-2/1-3 answer into the original global branch key (1-6) that
// setTopicBranchNode/setSlotBranchNode already expect, so nothing else in
// the graph needs to know a second level exists.
const TEMP_TOPIC_MAP = { 1: "1", 2: "2", 3: "3" };
function tempPromptNode() {
  const text = interrupt(TEMP_PROMPT_TEXT);
  const translated = TEMP_TOPIC_MAP[text.trim()];
  return { incomingText: translated ?? text };
}

const SETTLE_BRANCH_MAP = { 1: "4", 2: "5" };
function settlePromptNode() {
  const text = interrupt(SETTLE_PROMPT_TEXT);
  const translated = SETTLE_BRANCH_MAP[text.trim()];
  return { incomingText: translated ?? text };
}

const freeformAnswerNode = (answerFreeform) => async function freeformAnswerNode(state) {
  const tier = tierFor(state, state.incomingText);
  const result = await answerFreeform(state.incomingText, null, { tier });
  return { pendingMessage: result.text, ...answered(result, tier) };
};

// FIX-15 (S29): after a side question, "continue" resumes the intake and "stop" ends it.
const CONTINUE_WORDS = new Set(["continue", "yes", "y", "ok", "okay", "sure", "go on", "go ahead", "resume", "carry on", "next", "👍", "haan", "ji"]);
// Only an explicit stop ends the check; a bare "no" is ambiguous here and gets one clarifying line.
const STOP_WORDS = new Set(["stop", "end", "quit", "exit", "enough", "stop it"]);
const AMBIGUOUS_NO = new Set(["no", "n", "nope", "nah", "nahi", "not now"]);
const lastWords = (t) => t.trim().toLowerCase().replace(/[.!?,]+$/, "").replace(/\s+/g, " ");

// FIX-15b (C15, S20/S26): a repair marker plus a value re-binds the LAST answered slot
// ("sorry 30", "wait I am actually 34 not 32"). The marker words and the replaced value are
// stripped and the remainder must parse whole, so "sorry, no idea what this means" at a yes/no
// slot is not read as "no". Precedent: Rasa's correction pattern; the word list is a judgement call.
const CORRECTION_RE = /^(?:sorry|oops|wait|actually|correction|my bad|i meant|i mean|no,? i meant)\b|\b(?:actually|i meant|not \d+)\b/i;
function parseCorrection(text, state, slotDefs) {
  if (!state.slotIndex || !CORRECTION_RE.test(text)) return null;
  const slot = slotDefs[state.slotIndex - 1];
  const old = state.slots?.[slot.key];
  const rest = text
    .toLowerCase()
    .replace(/\bnot\s+\S+/g, " ")
    .replace(/\b(?:sorry|oops|wait|actually|correction|my bad|i meant|i mean|no,? i meant|i am|i'm|im|it is|it's|its|i have|i've)\b/g, " ")
    .replace(/[,.!?;:]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  for (const c of [rest, ...(rest.match(/\d+/g) ?? [])]) {
    const v = c ? slot.parse(c) : null;
    if (v !== null && typeof v !== "object" && v !== old) return { slot, value: v };
  }
  return null;
}

// FIX-15b (S26): a numbered recap before the intake summary; OK goes on, a number changes one answer.
const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);
function recapText(state) {
  const slotDefs = BRANCH_SLOTS[state.branch];
  const lines = slotDefs.map((s, i) => `${i + 1}) ${capitalize(s.label)}: ${state.slots?.[s.key]}`);
  return `Here's what I have:\n${lines.join("\n")}\n\nReply *OK*, or the item number to change it.`;
}
function editQuestion(slot) {
  if (slot.parse === parseYesNo) return slot.prompt;
  const options = slot.prompt.includes("\n") ? `\n${slot.prompt.split("\n").slice(1).join("\n")}` : "";
  return `What should your ${slot.label} be?${options}`;
}

function slotRecapNode(state) {
  const recap = recapText(state);
  const text = interrupt(state.pendingMessage ? `${state.pendingMessage}\n\n${recap}` : recap);
  return { incomingText: text, pendingMessage: null };
}
function routeFromRecap(state) {
  const text = (state.incomingText ?? "").trim();
  if (isResetCommand(text, { atIntake: true })) return "reset";
  if (parseYesNo(text) === "yes") return "slotSynthesis";
  const n = Number(normalizeChoice(text));
  if (Number.isInteger(n) && n >= 1 && n <= BRANCH_SLOTS[state.branch].length) return "slotEdit";
  return "slotRecap";
}
function slotEditNode(state) {
  const slotDefs = BRANCH_SLOTS[state.branch];
  const i = state.editingSlot ?? Number(normalizeChoice(state.incomingText ?? "")) - 1;
  const slot = slotDefs[i];
  const question = editQuestion(slot);
  const text = interrupt(state.pendingMessage ? `${state.pendingMessage}\n\n${question}` : question);
  if (isResetCommand(text, { atIntake: true })) return { incomingText: text, editingSlot: null, pendingMessage: null };
  const parsed = slot.parse(text);
  if (parsed && typeof parsed === "object" && parsed.reprompt) return { editingSlot: i, pendingMessage: parsed.reprompt, incomingText: "" };
  if (parsed === null) return { editingSlot: i, pendingMessage: "Sorry, I didn't quite catch that.", incomingText: "" };
  return { slots: { [slot.key]: parsed }, editingSlot: null, pendingMessage: null, incomingText: "" };
}
function routeFromSlotEdit(state) {
  if (isResetCommand(state.incomingText ?? "", { atIntake: true })) return "reset";
  return state.editingSlot !== null ? "slotEdit" : "slotRecap";
}

const slotFillNode = (answerFreeform) => async function slotFillNode(state) {
  const slotDefs = BRANCH_SLOTS[state.branch];
  const currentSlot = slotDefs[state.slotIndex];
  const label = CHECK_LABEL[state.branch];
  // bareReply: the pending message stands alone (a hint, or "continue or stop?"), no slot prompt.
  const prompt = state.bareReply
    ? state.pendingMessage
    : state.pendingMessage
      ? `${state.pendingMessage}\n\n${currentSlot.prompt}`
      : currentSlot.prompt;
  const text = interrupt(prompt);
  const base = { bareReply: false, awaitingContinue: false };

  if (isResetCommand(text, { atIntake: true })) {
    return { ...base, incomingText: text };
  }
  if (state.awaitingContinue) {
    if (CONTINUE_WORDS.has(lastWords(text))) return { ...base, pendingMessage: null, noMatch: 0 };
    if (STOP_WORDS.has(lastWords(text))) return { ...base, incomingText: "cancel" }; // → reset: "Okay, stopping…"
    if (AMBIGUOUS_NO.has(lastWords(text))) {
      return { ...base, pendingMessage: `Reply *stop* to end the ${label}, or *continue* to keep going.`, bareReply: true, awaitingContinue: true };
    }
    // Anything else falls through: a slot answer is taken as one, another question is answered.
  }

  const parsed = currentSlot.parse(text);
  // A parse can decline with guidance (e.g. an estimate where an exact count is needed): stay on this slot.
  if (parsed && typeof parsed === "object" && parsed.reprompt) {
    return { ...base, pendingMessage: parsed.reprompt };
  }
  if (parsed === null) {
    const fix = parseCorrection(text, state, slotDefs);
    if (fix) return { ...base, noMatch: 0, slots: { [fix.slot.key]: fix.value }, pendingMessage: `Updated: ${fix.slot.label} ${fix.value}.` };
    if (looksLikeRealQuestion(text) && !/^[0-9]+$/.test(text.trim())) {
      const tier = tierFor(state, text);
      const after = `Continue the ${label} (${state.slotIndex} of ${slotDefs.length} done), or stop?`;
      const result = await answerFreeform(text, null, { tier, after });
      return {
        ...base,
        // A long answer folds behind "Read more", so the paused state is said first (FIX-18).
        pendingMessage: `⏸️ ${capitalize(label)} paused — your question first.\n\n${result.text}`,
        bareReply: true,
        awaitingContinue: true,
        noMatch: 0,
        ...answered(result, tier),
      };
    }
    // Escalating no-match (S28; Rasa/Google tapering): restate, then a hint, then the way out.
    const noMatch = (state.noMatch ?? 0) + 1;
    if (noMatch === 1) return { ...base, noMatch, pendingMessage: "Sorry, I didn't quite catch that." };
    if (noMatch === 2) return { ...base, noMatch, pendingMessage: currentSlot.hint ?? "Sorry, I didn't quite catch that.", bareReply: !!currentSlot.hint };
    return { ...base, noMatch, pendingMessage: `Want to stop the ${label}? Reply *menu* to go back to the menu, or answer to keep going:` };
  }

  return {
    ...base,
    slots: { [currentSlot.key]: parsed },
    slotIndex: state.slotIndex + 1,
    pendingMessage: null,
    noMatch: 0,
  };
};

const slotSynthesisNode = (answerFreeform) => async function slotSynthesisNode(state) {
  const slotDefs = BRANCH_SLOTS[state.branch];
  const profileLine = slotDefs.map((s) => s.describe(state.slots[s.key])).join("; ");
  const composedQuestion =
    `My profile: ${profileLine}. Based on official IRCC eligibility criteria, ` +
    `roughly how does this look, and what should I consider next? ` +
    `Be clear this is a rough, informal read — not an official score.`;
  const tier = tierFor(state, composedQuestion);
  const result = await answerFreeform(composedQuestion, BRANCH_SOURCES[state.branch], {
    retrievalQuery: BRANCH_RETRIEVAL_QUERY[state.branch],
    tier,
  });
  return { pendingMessage: result.text, branch: null, slotIndex: 0, slots: CLEAR_SLOTS, ...answered(result, tier) };
};

// --- routing -------------------------------------------------------------

function routeFromStart(state) {
  const text = (state.incomingText ?? "").trim();
  // A bare digit as her very first-ever message (e.g. she saw the menu
  // secondhand and jumped straight in) should act on it directly, same as
  // it does mid-conversation — not get silently discarded in favor of
  // showing the menu from scratch. Delegates to routeFromMenu's own
  // top-level (1-3) matching; anything else falls through to quickAnswer
  // there, which is a reasonable, honest response either way.
  if (/^\d$/.test(normalizeChoice(text))) return routeFromMenu(state);
  if (isMoreRequest(text)) return "more";
  if (classifyAct(text)) return "smallTalk";
  if (looksLikeRealQuestion(text)) return "quickAnswer";
  return "menu";
}

// Top level is a 3-way split (progressive disclosure); 1 and 2 lead to a
// second short prompt that narrows further, rather than all six original
// options appearing at once.
function routeFromMenu(state) {
  const text = (state.incomingText ?? "").trim();
  if (isResetCommand(text)) return "reset";
  const choice = normalizeChoice(text); // "1.", "one", "2!" are choices too (S16)
  if (choice === "1") return "tempPrompt";
  if (choice === "2") return "settlePrompt";
  if (choice === "3") return "freeformPrompt";
  if (isMoreRequest(text)) return "more";
  if (classifyAct(text)) return "smallTalk";
  return "quickAnswer";
}

function routeFromTempPrompt(state) {
  const text = (state.incomingText ?? "").trim();
  if (isResetCommand(text)) return "reset";
  if (TOPIC_BRANCHES[text]) return "setTopicBranch"; // already translated to the original 1-3 key
  if (classifyAct(text)) return "smallTalk";
  return "quickAnswer";
}

function routeFromSettlePrompt(state) {
  const text = (state.incomingText ?? "").trim();
  if (isResetCommand(text)) return "reset";
  if (BRANCH_SLOTS[text]) return "setSlotBranch"; // already translated to the original 4/5 key
  if (classifyAct(text)) return "smallTalk";
  return "quickAnswer";
}

function routeFromSlotFill(state) {
  const text = (state.incomingText ?? "").trim();
  if (isResetCommand(text, { atIntake: true })) return "reset";
  if (state.slotIndex >= BRANCH_SLOTS[state.branch].length) return "slotRecap";
  return "slotFill";
}

// --- graph assembly -----------------------------------------------------

function setTopicBranchNode(state) {
  return { branch: state.incomingText.trim().match(/^[1-6]$/)[0] };
}

function setSlotBranchNode(state) {
  return { branch: state.incomingText.trim().match(/^[1-6]$/)[0], slotIndex: 0, slots: {} };
}

function routeFromRoot(state) {
  if (state.hasGreeted) return "entry";
  // A brand-new chat: answer a real opening question now (FIX-02); greet anything else.
  const text = state.incomingText ?? "";
  if (classifyAct(text)) return "smallTalk";
  return looksLikeRealQuestion(text) && !isResetCommand(text) ? "quickAnswer" : "greeting";
}

function buildGraph(overrides = {}) {
  const { retryPolicy, ...deps } = overrides;
  const answerFreeform = makeAnswerFreeform({ ...DEFAULT_DEPS, ...deps });
  return new StateGraph(State)
  .addNode("greeting", greetingNode)
  .addNode("entry", entryNode)
  .addNode("reset", resetNode)
  .addNode("menu", menuNode)
  .addNode("smallTalk", smallTalkNode)
  .addNode("more", moreNode)
  .addNode("quickAnswer", quickAnswerNode(answerFreeform), { retryPolicy: retryPolicy ?? RAG_RETRY })
  .addNode("tempPrompt", tempPromptNode)
  .addNode("settlePrompt", settlePromptNode)
  .addNode("setTopicBranch", setTopicBranchNode)
  .addNode("topicPrompt", topicPromptNode)
  .addNode("topicAnswer", topicAnswerNode(answerFreeform), { retryPolicy: retryPolicy ?? RAG_RETRY })
  .addNode("freeformPrompt", freeformPromptNode)
  .addNode("freeformAnswer", freeformAnswerNode(answerFreeform), { retryPolicy: retryPolicy ?? RAG_RETRY })
  .addNode("setSlotBranch", setSlotBranchNode)
  .addNode("slotFill", slotFillNode(answerFreeform), { retryPolicy: retryPolicy ?? RAG_RETRY })
  .addNode("slotSynthesis", slotSynthesisNode(answerFreeform), { retryPolicy: retryPolicy ?? RAG_RETRY })
  .addNode("slotRecap", slotRecapNode)
  .addNode("slotEdit", slotEditNode)

  .addConditionalEdges(START, routeFromRoot, {
    greeting: "greeting",
    entry: "entry",
    quickAnswer: "quickAnswer",
    smallTalk: "smallTalk",
  })
  .addEdge("greeting", "entry")
  .addConditionalEdges("entry", routeFromStart, {
    quickAnswer: "quickAnswer",
    smallTalk: "smallTalk",
    menu: "menu",
    more: "more",
    reset: "reset",
    tempPrompt: "tempPrompt",
    settlePrompt: "settlePrompt",
    freeformPrompt: "freeformPrompt",
  })
  .addConditionalEdges("menu", routeFromMenu, {
    reset: "reset",
    tempPrompt: "tempPrompt",
    settlePrompt: "settlePrompt",
    freeformPrompt: "freeformPrompt",
    quickAnswer: "quickAnswer",
    smallTalk: "smallTalk",
    more: "more",
  })
  .addConditionalEdges("reset", routeFromReset, { menu: "menu", quickAnswer: "quickAnswer", smallTalk: "smallTalk" })
  .addEdge("smallTalk", "menu")
  .addEdge("more", "menu")
  .addEdge("quickAnswer", "menu")

  .addConditionalEdges("tempPrompt", routeFromTempPrompt, {
    reset: "reset",
    setTopicBranch: "setTopicBranch",
    quickAnswer: "quickAnswer",
    smallTalk: "smallTalk",
  })
  .addConditionalEdges("settlePrompt", routeFromSettlePrompt, {
    reset: "reset",
    setSlotBranch: "setSlotBranch",
    quickAnswer: "quickAnswer",
    smallTalk: "smallTalk",
  })

  .addEdge("setTopicBranch", "topicPrompt")
  .addEdge("topicPrompt", "topicAnswer")
  .addEdge("topicAnswer", "menu")

  .addEdge("freeformPrompt", "freeformAnswer")
  .addEdge("freeformAnswer", "menu")

  .addEdge("setSlotBranch", "slotFill")
  .addConditionalEdges("slotFill", routeFromSlotFill, {
    reset: "reset",
    slotFill: "slotFill",
    slotRecap: "slotRecap",
  })
  .addConditionalEdges("slotRecap", routeFromRecap, {
    reset: "reset",
    slotSynthesis: "slotSynthesis",
    slotEdit: "slotEdit",
    slotRecap: "slotRecap",
  })
  .addConditionalEdges("slotEdit", routeFromSlotEdit, { reset: "reset", slotEdit: "slotEdit", slotRecap: "slotRecap" })
  .addEdge("slotSynthesis", "menu");
}

// The production graph, with the real dependencies (index.js, simulate.js).
const builder = buildGraph();

// FIX-23: the pending intake question, if the chat is mid-intake (so a media reply can restate it).
function pendingPromptText(values = {}) {
  const slots = BRANCH_SLOTS[values.branch];
  return slots?.[values.slotIndex ?? 0]?.prompt ?? null;
}

export { builder, buildGraph, pendingPromptText, State };
