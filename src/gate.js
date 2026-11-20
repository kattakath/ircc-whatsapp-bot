// Pre-router dialogue-act gate (docs/conversation-design.md FIX-09).
//
// Runs only where NO prompt is pending (menu-level routing): a pending yes/no, choice or slot
// prompt binds first (P18 order; Rasa form validation maps slots before intent fallback).
// Short non-questions used to reach retrieval + the LLM, a ~27 s turn for "thanks" or "1."
// (measured). Each class here gets an instant, fixed reply — or deliberate silence for a bare
// acknowledgement, matching how people close a sequence (Schegloff & Sacks 1973, "Opening up
// closings"). The lexicons are judgement calls, measured by the FIX-01 collision corpus.
import { STATUS_URL } from "./redact.js";

const CONTACT_URL = "https://www.canada.ca/en/immigration-refugees-citizenship/corporate/contact-ircc.html";
const REPRESENTATIVE_URL = "https://www.canada.ca/en/immigration-refugees-citizenship/services/immigration-citizenship-representative/choose.html";
const MENU_HINT = "Ask me a question, or reply 1, 2 or 3.";

export const REPLIES = {
  closing: "You're welcome! 🙂 Ask me anytime.",
  ack: "", // deliberate silence: replying to 👍 is noise, not help
  prod: `I'm here 🙂 ${MENU_HINT}`,
  noise: `Sorry, I didn't catch that. ${MENU_HINT}`,
  hold: "No problem 🙂 Ask whenever you're ready.",
  // FIX-22 (S18): options and an explanation, the repairs users prefer (Ashktorab et al. CHI 2019).
  complaint:
    "Sorry about that. You can:\n" +
    "• ask it another way, and I'll look again\n" +
    "• reply *source* to see the official page I used\n" +
    `• check with a licensed consultant or lawyer: ${REPRESENTATIVE_URL}`,
  identity:
    "I'm a helper bot, not IRCC and not a person. I read public canada.ca pages and can't see anyone's files or applications.\n" +
    `To reach IRCC itself: ${CONTACT_URL}`,
  handoff:
    "I can't call you or connect you to a person.\n" +
    `• Contact IRCC: ${CONTACT_URL}\n` +
    `• Find a licensed consultant or lawyer: ${REPRESENTATIVE_URL}`,
  fileCheck: `I can't see applications or files. To check yours, sign in to your IRCC account: ${STATUS_URL}`,
};

const norm = (t) =>
  t
    .trim()
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ");
const words = (t) => t.replace(/[^\p{L}\p{N}' ]/gu, " ").trim().split(/\s+/).filter(Boolean);
const hasLetters = (t) => /[\p{L}\p{N}]/u.test(t);

const POLITE_PREFIX = "(?:(?:ok|okay|cool|great|perfect|got it|alright|oh|ah)[,!. ]+)*";
const CLOSING_RE = new RegExp(
  `^${POLITE_PREFIX}(?:thanks?|thank ?you|thx|ty|tysm|cheers|bye|good ?bye|many thanks)(?:[ ,!.]+(?:so much|very much|a lot|again|sir|madam|dear|bro|brother|sis|ji))*[\\s!.🙏😊🙂❤️👍]*$`,
);
const ACK_SET = new Set(["ok", "okay", "k", "kk", "cool", "great", "nice", "alright", "got it", "sure", "fine", "yes", "yeah", "no", "nope", "haan", "ji", "lol", "haha", "hmm", "hm", "noted", "ok cool", "okay cool"]);
const PROD_RE = /^(?:(?:hello|hi|hey|helo|hlo)[!?. ]*)?(?:\?+|are you there\??|anyone there\??|still there\??|u there\??|you there\??)$|^(?:hello|hi|hey|helo|hlo)\?{2,}/;
const HOLD_RE = /^(?:sorry|wait|hold on|one sec|one second|never ?mind|nvm|my bad|oops|wrong number)\b/;
const COMPLAINT_SET = new Set(["wrong", "that's wrong", "thats wrong", "that is wrong", "not correct", "incorrect", "no that's wrong", "no thats wrong", "👎"]);
// FIX-22: "show me the page", "which page did you use", "source", "link".
const SOURCES_RE = /^(?:(?:can you |pls |please )?(?:show|send|give)(?: me)? (?:the )?(?:page|link|source|sources|website)|(?:which|what) (?:page|link|source|website) (?:did you use|is that from|was that)|sources?|links?|the page|the link)[?!. ]*$/;
const COMPLAINT_LEAD_RE = /^(?:no[,.! ]+)?(?:that'?s|thats|that is|it'?s|its)? ?(?:wrong|not right|incorrect|not correct)\b[,.!]*\s*/;
export const SOURCES_NONE = "I don't have a page to show for that yet. Ask your question and I'll include the official link.";

/** C14: a complaint that still has content after the complaint words ("no thats wrong, I asked for my mother"). */
export function isComplaintWithContent(raw) {
  const t = norm(raw ?? "");
  const m = t.match(COMPLAINT_LEAD_RE);
  return !!m && m[0].length > 0 && words(t.slice(m[0].length)).length >= 2;
}

const IDENTITY_RE = /\b(?:are|r) (?:you|u) (?:from |with )?(?:ircc|the government|government|a bot|bot|a robot|robot|human|a human|real|a real person|a person|ai|an ai)\b|\bwho (?:are|r) (?:you|u)\b/;
const HANDOFF_RE = /\b(?:talk|speak|chat) (?:to|with) (?:someone|somebody|a person|a human|an agent|an officer|a real person)\b|\b(?:call|phone|ring) me\b|\bcan (?:you|u) call\b|\bhuman agent\b/;
const FILE_RE = /\b(?:check|see|look at|look into|open|review) (?:my|our|his|her) (?:file|application|case|status)\b/;

/**
 * Classify a menu-level message. Returns { kind, reply } for a recognised dialogue act, or null
 * when it should take the normal route (a choice, a reset, or a real question for RAG).
 */
export function classifyAct(raw) {
  const t = norm(raw ?? "");
  if (!t) return null;
  if (SOURCES_RE.test(t)) return { kind: "sources", reply: null };
  if (IDENTITY_RE.test(t)) return { kind: "identity", reply: REPLIES.identity };
  if (HANDOFF_RE.test(t)) return { kind: "handoff", reply: REPLIES.handoff };
  if (FILE_RE.test(t)) return { kind: "fileCheck", reply: REPLIES.fileCheck };
  if (PROD_RE.test(t)) return { kind: "prod", reply: REPLIES.prod };
  if (!hasLetters(t)) {
    if (/🙏/u.test(t)) return { kind: "closing", reply: REPLIES.closing };
    if (/👎/u.test(t)) return { kind: "complaint", reply: REPLIES.complaint };
    return { kind: /[👍👌✅]/u.test(t) ? "ack" : "noise", reply: /[👍👌✅]/u.test(t) ? REPLIES.ack : REPLIES.noise };
  }
  const bare = t.replace(/[!.?,]+$/g, "").trim();
  if (CLOSING_RE.test(bare)) return { kind: "closing", reply: REPLIES.closing };
  if (ACK_SET.has(bare)) return { kind: "ack", reply: REPLIES.ack };
  if (COMPLAINT_SET.has(bare)) return { kind: "complaint", reply: REPLIES.complaint };
  const w = words(t);
  if (HOLD_RE.test(t) && w.length <= 5 && !t.includes("?")) return { kind: "hold", reply: REPLIES.hold };
  // Keyboard mash: one long token with almost no vowels ("asdfgh", "qwrtyp").
  if (w.length === 1 && /^[a-z]{5,}$/.test(w[0]) && (w[0].match(/[aeiouy]/g) ?? []).length <= 1) {
    return { kind: "noise", reply: REPLIES.noise };
  }
  return null;
}

/** A short message is still a question when it asks one or names an acronym ("PGWP?", "eTA"). */
export function isShortQuestion(raw) {
  const t = (raw ?? "").trim();
  if (!t || PROD_RE.test(norm(t))) return false;
  return (/\?\s*$/.test(t) && /\p{L}{2,}/u.test(t)) || /^[A-Za-z]{2,6}\??$/.test(t) && /[A-Z]{2,}/.test(t);
}

// --- FIX-39: forwarded messages (S51) ------------------------------------------------------
// WhatsApp marks forwards (contextInfo.isForwarded, exposed by FIX-05). A forwarded message with
// scam signs (money + urgency, or a threat + urgency/money) gets IRCC's own fraud guidance and is
// never restated or searched. The facts below are from the IRCC page linked in the reply
// (checked 2026-11-20): "We will never ask you for any sort of payment by telephone", "We will
// never send you an email asking for your private information", "We do not send visas by email".
const SCAM_URL = "https://www.canada.ca/en/immigration-refugees-citizenship/services/protect-fraud/internet-email-telephone.html";
const REPORT_URL = "https://www.canada.ca/en/immigration-refugees-citizenship/services/protect-fraud/report-fraud.html";
/** The fixed fraud-check reply; a pasted notice is not called "forwarded". */
export const fraudCheck = ({ forwarded = true } = {}) =>
  `⚠️ This ${forwarded ? "forwarded " : ""}message has signs of a scam. IRCC says it never asks for any payment by phone and never emails you asking for private information.\n` +
  "Don't pay or share any details until you check yourself, in your IRCC account or on the official site:\n" +
  `🔗 ${SCAM_URL}\n` +
  `To report it: 🔗 ${REPORT_URL}`;
export const FRAUD_CHECK = fraudCheck({ forwarded: true });
export const FORWARDED_PREFACE = "This was forwarded — here's what the official canada.ca pages say:";

const MONEY_RE = /\$\s?\d|\b(?:pay|payment|paid|fee|fine|penalty|gift ?cards?|bitcoin|crypto|wire|transfer|deposit|western union|money ?gram|e-?transfer)\b/i;
const URGENCY_RE = /\b(?:now|immediately|urgent(?:ly)?|today|asap|within \d+ ?(?:hours?|hrs?|days?)|last chance|final notice|right away)\b/i;
const THREAT_RE = /\b(?:cancel(?:led|ed)?|revoked?|deport(?:ed|ation)?|arrest(?:ed)?|police|suspend(?:ed)?|blocked|legal action|warrant)\b/i;

/** Scam signs in a forwarded text: money + urgency, or a threat with urgency or money. */
export function isScamLike(text) {
  const t = text ?? "";
  const money = MONEY_RE.test(t), urgent = URGENCY_RE.test(t), threat = THREAT_RE.test(t);
  return (money && urgent) || (threat && (urgent || money));
}

// FIX-39b: a PASTED notice (or one its author forwarded back, which WhatsApp does not mark) has no
// forwarded flag, so it needs a stricter test that a person's own question cannot meet: a payment
// rail scammers use and IRCC never does, or a notice addressed to "your" permit/visa/status.
const SCAM_RAIL_RE = /\b(?:gift ?cards?|bitcoin|crypto(?:currency)?|western union|money ?gram|prepaid (?:visa|card))\b/i;
const NOTICE_RE = /\byour (?:study |work )?(?:visa|permit|pr(?: card)?|status|application|file|case|sin|passport)\b[^.?!]{0,40}\b(?:is|was|has been|will be)\b/i;

/** Scam signs in a pasted (not forwarded) text: scam-like AND a scam payment rail or a notice to "your" permit. */
export function isPastedScam(text) {
  const t = text ?? "";
  return isScamLike(t) && (SCAM_RAIL_RE.test(t) || NOTICE_RE.test(t));
}

/** What to do with a text: "fraud" (fixed reply), "forwarded" (answer with a preface), or null (normal turn). */
export function scamAction(inbound) {
  if (inbound?.kind !== "text") return null;
  if (inbound.forwarded) return isScamLike(inbound.text) ? "fraud" : "forwarded";
  return isPastedScam(inbound.text) ? "fraud" : null;
}
