import { StateGraph, Annotation, interrupt, Command, START, END } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { retrieve } from "./db.js";
import { synthesize } from "./llm.js";
import { webFallback, persistWebFallback } from "./websearch.js";

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
  "Hi! I can help with questions about coming to Canada, using the official IRCC website.\n\n" +
  MENU_OPTIONS_TEXT;

const MENU_SHORT_REMINDER =
  "Want to explore a specific path? Reply with a number:\n" +
  "1) Visit/study/work  2) Settle permanently or citizenship  3) Ask anything else";

const TEMP_PROMPT_TEXT = "Got it — which one?\n1) Visit\n2) Study\n3) Work";
const SETTLE_PROMPT_TEXT =
  "Got it — which one?\n1) Settle permanently (PR / Express Entry)\n2) Become a Canadian citizen";

// Word-boundary match, not exact-string match — "menu please" or "can you
// restart" should reset just as much as a bare "menu" does. Length-capped
// so a genuinely long question that happens to contain one of these words
// isn't misread as a reset command.
const RESET_PATTERNS = [/\bmenu\b/i, /\brestart\b/i, /\breset\b/i, /\bstart (over|again)\b/i];
function isResetCommand(text) {
  const t = text.trim();
  return t.length > 0 && t.length <= 30 && RESET_PATTERNS.some((p) => p.test(t));
}

// Slot answers come from someone who isn't very technical — a stray period,
// extra space, or writing the number as a word shouldn't count as "invalid".
const NUMBER_WORDS = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
function normalizeChoice(text) {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  return NUMBER_WORDS[t] ?? t;
}

const YES_WORDS = new Set(["y", "yes", "yeah", "yep", "ya", "yup"]);
const NO_WORDS = new Set(["n", "no", "nope", "nah"]);
function parseYesNo(text) {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (YES_WORDS.has(t)) return "yes";
  if (NO_WORDS.has(t)) return "no";
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
    prompt: "How old are you? (just the number)",
    parse: (t) => {
      const n = parseInt(t, 10);
      return Number.isInteger(n) && n >= 15 && n <= 100 ? n : null;
    },
    describe: (v) => `age ${v}`,
  },
  {
    key: "education",
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
    prompt: "Have you ever worked inside Canada? Reply yes or no.",
    parse: parseYesNo,
    describe: (v) => `Canadian work experience: ${v}`,
  },
  {
    key: "jobOfferOrPN",
    prompt:
      "Do you have a valid job offer from a Canadian employer, or a provincial nomination? Reply yes or no.",
    parse: parseYesNo,
    describe: (v) => `job offer or provincial nomination: ${v}`,
  },
];

const CITIZENSHIP_SLOTS = [
  {
    key: "prStatus",
    prompt: "Do you currently have valid Canadian permanent resident (PR) status? Reply yes or no.",
    parse: parseYesNo,
    describe: (v) => `has PR status: ${v}`,
  },
  {
    key: "yearsPresent",
    prompt:
      "Roughly how many total days have you physically been in Canada in the last 5 years " +
      "(as PR, and also count any time before that as a temporary resident or protected person)? " +
      "A rough number is fine.",
    parse: (t) => {
      const n = parseInt(t.replace(/[^0-9]/g, ""), 10);
      return Number.isInteger(n) && n >= 0 && n <= 3650 ? n : null;
    },
    describe: (v) => `roughly ${v} days physically present in Canada in the last 5 years`,
  },
  {
    key: "taxYears",
    prompt: "In how many of the last 5 years did you file Canadian income taxes? (0-5)",
    parse: (t) => {
      const n = parseInt(t, 10);
      return Number.isInteger(n) && n >= 0 && n <= 5 ? n : null;
    },
    describe: (v) => `filed taxes in ${v} of the last 5 years`,
  },
  {
    key: "age",
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

function looksLikeRealQuestion(text) {
  return text.trim().length > 12;
}

// CRAG-style grading, simplified: real CRAG grades each doc via an LLM into
// correct/incorrect/ambiguous. Here the grade is the top cosine-similarity
// score against a stricter threshold than db.js's own SIMILARITY_FLOOR
// (0.3, which just filters noise) — below GRADE_THRESHOLD, local retrieval
// is treated as "incorrect" and discarded in favor of a canada.ca-scoped
// live search, same as CRAG's incorrect branch. This trades grading
// precision for zero extra latency (an LLM grading call would stack with
// the already-slow synthesis call).
const GRADE_THRESHOLD = 0.5;

async function answerFreeform(question, sources = null) {
  let chunks = await retrieve(question, { sources });
  const gradedWell = chunks.length > 0 && chunks[0].similarity >= GRADE_THRESHOLD;

  if (!gradedWell) {
    const webChunks = await webFallback(question);
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

  return synthesize(question, chunks);
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
  slots: Annotation({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  // Not returned by resetNode, so a "menu"/reset command never re-triggers
  // it — this is specifically the very first message on this thread ever,
  // not "the start of the current conversation".
  hasGreeted: Annotation({ default: () => false }),
});

// No yes/no framing ("...do you?") — a closed question invites a
// confirmatory reply ("Yes, what should I do?") long enough to trip
// looksLikeRealQuestion in routeFromStart below and get misrouted into
// quickAnswer's RAG path instead of the menu. Lead straight into the
// numbered menu instead, same as MENU_TEXT, so the very first message
// already tells her exactly how to reply.
const GREETING_TEXT =
  "Hey dear 👋🏽, I'm Izzy's Minion 🤓 — I can help with questions about coming to Canada, using the official IRCC website.\n\n" +
  MENU_OPTIONS_TEXT;

// --- nodes -------------------------------------------------------------------

function resetNode() {
  return { pendingMessage: null, started: false, branch: null, slotIndex: 0, slots: {} };
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

function menuNode(state) {
  const text = interrupt(
    state.pendingMessage ? `${state.pendingMessage}\n\n${MENU_SHORT_REMINDER}` : MENU_TEXT
  );
  return { incomingText: text, pendingMessage: null, started: true };
}

async function quickAnswerNode(state) {
  const answer = await answerFreeform(state.incomingText);
  return { pendingMessage: answer };
}

function topicPromptNode(state) {
  const branch = TOPIC_BRANCHES[state.branch];
  const text = interrupt(`Sure — what would you like to know about ${branch.label}? Ask anything, in your own words.`);
  return { incomingText: text };
}

async function topicAnswerNode(state) {
  const branch = TOPIC_BRANCHES[state.branch];
  const answer = await answerFreeform(state.incomingText, branch.sources);
  return { pendingMessage: answer, branch: null };
}

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

async function freeformAnswerNode(state) {
  const answer = await answerFreeform(state.incomingText);
  return { pendingMessage: answer };
}

async function slotFillNode(state) {
  const slotDefs = BRANCH_SLOTS[state.branch];
  const currentSlot = slotDefs[state.slotIndex];
  const prompt = state.pendingMessage ? `${state.pendingMessage}\n\n${currentSlot.prompt}` : currentSlot.prompt;
  const text = interrupt(prompt);

  if (isResetCommand(text)) {
    return { incomingText: text };
  }

  const parsed = currentSlot.parse(text);
  if (parsed === null) {
    if (looksLikeRealQuestion(text) && !/^[0-9]+$/.test(text.trim())) {
      const answer = await answerFreeform(text);
      return { pendingMessage: `${answer}\n\nWhenever you're ready, back to the last question:` };
    }
    return { pendingMessage: "Sorry, I didn't quite catch that." };
  }

  return {
    slots: { [currentSlot.key]: parsed },
    slotIndex: state.slotIndex + 1,
    pendingMessage: null,
  };
}

async function slotSynthesisNode(state) {
  const slotDefs = BRANCH_SLOTS[state.branch];
  const profileLine = slotDefs.map((s) => s.describe(state.slots[s.key])).join("; ");
  const composedQuestion =
    `My profile: ${profileLine}. Based on official IRCC eligibility criteria, ` +
    `roughly how does this look, and what should I consider next? ` +
    `Be clear this is a rough, informal read — not an official score.`;
  const answer = await answerFreeform(composedQuestion, BRANCH_SOURCES[state.branch]);
  return { pendingMessage: answer, branch: null, slotIndex: 0, slots: {} };
}

// --- routing -------------------------------------------------------------

function routeFromStart(state) {
  const text = (state.incomingText ?? "").trim();
  // A bare digit as her very first-ever message (e.g. she saw the menu
  // secondhand and jumped straight in) should act on it directly, same as
  // it does mid-conversation — not get silently discarded in favor of
  // showing the menu from scratch. Delegates to routeFromMenu's own
  // top-level (1-3) matching; anything else falls through to quickAnswer
  // there, which is a reasonable, honest response either way.
  if (/^\d$/.test(text)) return routeFromMenu(state);
  if (looksLikeRealQuestion(text)) return "quickAnswer";
  return "menu";
}

// Top level is a 3-way split (progressive disclosure); 1 and 2 lead to a
// second short prompt that narrows further, rather than all six original
// options appearing at once.
function routeFromMenu(state) {
  const text = (state.incomingText ?? "").trim();
  if (isResetCommand(text)) return "reset";
  if (text === "1") return "tempPrompt";
  if (text === "2") return "settlePrompt";
  if (text === "3") return "freeformPrompt";
  return "quickAnswer";
}

function routeFromTempPrompt(state) {
  const text = (state.incomingText ?? "").trim();
  if (isResetCommand(text)) return "reset";
  if (TOPIC_BRANCHES[text]) return "setTopicBranch"; // already translated to the original 1-3 key
  return "quickAnswer";
}

function routeFromSettlePrompt(state) {
  const text = (state.incomingText ?? "").trim();
  if (isResetCommand(text)) return "reset";
  if (BRANCH_SLOTS[text]) return "setSlotBranch"; // already translated to the original 4/5 key
  return "quickAnswer";
}

function routeFromSlotFill(state) {
  const text = (state.incomingText ?? "").trim();
  if (isResetCommand(text)) return "reset";
  if (state.slotIndex >= BRANCH_SLOTS[state.branch].length) return "slotSynthesis";
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
  return state.hasGreeted ? "entry" : "greeting";
}

const builder = new StateGraph(State)
  .addNode("greeting", greetingNode)
  .addNode("entry", entryNode)
  .addNode("reset", resetNode)
  .addNode("menu", menuNode)
  .addNode("quickAnswer", quickAnswerNode)
  .addNode("tempPrompt", tempPromptNode)
  .addNode("settlePrompt", settlePromptNode)
  .addNode("setTopicBranch", setTopicBranchNode)
  .addNode("topicPrompt", topicPromptNode)
  .addNode("topicAnswer", topicAnswerNode)
  .addNode("freeformPrompt", freeformPromptNode)
  .addNode("freeformAnswer", freeformAnswerNode)
  .addNode("setSlotBranch", setSlotBranchNode)
  .addNode("slotFill", slotFillNode)
  .addNode("slotSynthesis", slotSynthesisNode)

  .addConditionalEdges(START, routeFromRoot, {
    greeting: "greeting",
    entry: "entry",
  })
  .addEdge("greeting", "entry")
  .addConditionalEdges("entry", routeFromStart, {
    quickAnswer: "quickAnswer",
    menu: "menu",
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
  })
  .addEdge("reset", "menu")
  .addEdge("quickAnswer", "menu")

  .addConditionalEdges("tempPrompt", routeFromTempPrompt, {
    reset: "reset",
    setTopicBranch: "setTopicBranch",
    quickAnswer: "quickAnswer",
  })
  .addConditionalEdges("settlePrompt", routeFromSettlePrompt, {
    reset: "reset",
    setSlotBranch: "setSlotBranch",
    quickAnswer: "quickAnswer",
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
    slotSynthesis: "slotSynthesis",
  })
  .addEdge("slotSynthesis", "menu");

export { builder, State };
