// One clarifying question for vague input (docs/conversation-design.md FIX-19, S37, S47).
// Precedent: Aliannejadi et al. 2019 ("Asking Clarifying Questions in Open-Domain Information-
// Seeking Conversations") and Rasa's clarification pattern: when a query is ambiguous, ONE
// targeted question beats a generic answer. Only the clarifying branch ships here; abstaining on
// an ANSWERABLE flag waits for open question 9 (gpt-oss's reliability is unmeasured).
//
// Two triggers, both deterministic (no LLM call, so the reply is instant):
// - a bare ambiguous topic word ("permit?", "visa", "fees") → which one;
// - a delay story with no question ("applied in July… still nothing, agent not replying") →
//   normal processing times, or what to do if it's taking too long.
// The user's reply binds to the question only on the very next message (graph.js).

const OPTIONS = {
  study: { match: /\b(study|student|school|college|university|1)\b/, query: "How do I get a study permit?" },
  work: { match: /\b(work|job|working|2)\b/, query: "How do I get a work permit?" },
  visitor: { match: /\b(visit|visitor|visiting|tourist|tourism|3)\b/, query: "How do I get a visitor visa?" },
};
const FEE_OPTIONS = {
  visitor: { match: /\b(visit|visitor|tourist|1)\b/, query: "What is the fee for a visitor visa?" },
  study: { match: /\b(study|student|2)\b/, query: "What is the fee for a study permit?" },
  work: { match: /\b(work|job|3)\b/, query: "What is the fee for a work permit?" },
  pr: { match: /\b(pr|permanent|residence|express entry|4)\b/, query: "What are the fees for permanent residence?" },
  citizenship: { match: /\b(citizen|citizenship|5)\b/, query: "What is the fee to apply for Canadian citizenship?" },
};
const TOPICS = {
  permit: { question: "Which permit do you mean — study, work or visitor?", options: OPTIONS },
  visa: { question: "Which do you mean — a visitor visa, a study permit or a work permit?", options: OPTIONS },
  fee: { question: "Fees for what — a visitor visa, study permit, work permit, PR or citizenship?", options: FEE_OPTIONS },
};
const ALIASES = { permit: "permit", permits: "permit", visa: "visa", visas: "visa", fee: "fee", fees: "fee", cost: "fee", costs: "fee", price: "fee" };
const FILLER = new Set(["please", "pls", "plz", "the", "a", "an", "about", "info", "information", "my", "what", "and"]);

const words = (t) =>
  String(t ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** The vague topic key ("permit" | "visa" | "fee") when the WHOLE message is just that word. */
export function vagueTopic(text) {
  const w = words(text).filter((x) => !FILLER.has(x));
  return w.length === 1 ? (ALIASES[w[0]] ?? null) : null;
}

// A delay story: no question asked, but waiting / no reply / stuck. Only this kind for now (S47).
const QUESTION_START = /^(how|what|when|where|why|who|which|can|could|do|does|did|is|are|am|will|would|should|may|must)\b/i;
const DELAY = /\b(still (nothing|waiting|no|not)|no (update|updates|reply|response|news|answer)|not (replying|responding|answering)|haven'?t (heard|received|got)|waiting (for|since)|taking (so |too )?long|delayed|stuck)\b/i;
const PROGRAM = /\b(study permit|work permit|visitor visa|visitor record|permanent residence|pr card|citizenship|passport|express entry|sponsorship|spousal sponsorship)\b/i;
export const DELAY_QUESTION = "Do you want to know 1) the normal processing times, or 2) what to do if it's taking too long?";

/** A delay story with no question: { program } (program may be null), else null. */
export function delayStory(text) {
  const t = String(text ?? "").trim();
  if (t.includes("?") || QUESTION_START.test(t) || t.length < 30 || !DELAY.test(t)) return null;
  return { program: t.match(PROGRAM)?.[1]?.toLowerCase() ?? null };
}

/** The clarification to ask for `text`, or null: { kind, key?, program?, question }. */
export function clarificationFor(text) {
  const key = vagueTopic(text);
  if (key) return { kind: "topic", key, question: TOPICS[key].question };
  const story = delayStory(text);
  if (story) return { kind: "delay", program: story.program, question: DELAY_QUESTION };
  return null;
}

/** The query a reply to `clarify` stands for, or null when the reply is something else. */
export function resolveClarification(clarify, reply) {
  if (!clarify) return null;
  const r = words(reply).join(" ");
  if (!r) return null;
  if (clarify.kind === "topic") {
    const hit = Object.values(TOPICS[clarify.key]?.options ?? {}).find((o) => o.match.test(r));
    return hit && r.split(" ").length <= 4 ? hit.query : null;
  }
  // FIX-20: "Which country are you applying from?" — the reply names it; phrase it so liveIntent matches.
  if (clarify.kind === "ptime") {
    if (r.split(" ").length > 5 || !clarify.phrase) return null;
    return `How long is the ${clarify.phrase} processing time from ${reply.trim().replace(/[?.!]+$/, "")}?`;
  }
  if (clarify.kind === "delay") {
    const what = clarify.program ? `my ${clarify.program} application` : "my application";
    if (/\b(2|what (to|can i|should i) do|too long|delay|delayed|help|late)\b/.test(r)) {
      return `${capitalize(what)} is taking longer than the normal processing time. What can I do?`;
    }
    if (/\b(1|normal|processing|times?|how long)\b/.test(r)) {
      return `What are the normal processing times for ${clarify.program ? `a ${clarify.program}` : "an application"}?`;
    }
  }
  return null;
}
const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);
