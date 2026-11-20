// Control words (docs/conversation-design.md FIX-15, C8; S27).
//
// isResetCommand used to match "menu", "reset", "restart" or "start over" ANYWHERE in a message
// of up to 30 characters, so "reset my GCKey password" (a real question) showed the menu. C8:
// normalise first (case, punctuation, emoji, politeness words), then match the WHOLE message.
// A few phrases also match at the START, and the rest of the message is answered (S27: "can we
// start over please, I want to ask about my mom visiting"). `cancel` matches only as the whole
// message, and only at an intake prompt: "cancel my visa application" stays a question.
// Precedent: Rasa's restart/cancel patterns; the word lists are a judgement call.

const POLITE_PHRASES = /\b(?:go back to|take me to|can you|can we|could you|lets|let us)\b/g;
const POLITE_WORDS = new Set(["please", "pls", "plz", "show", "main", "the", "ok", "okay", "again"]);
const WHOLE = new Set(["menu", "reset", "restart", "start over", "start again", "never mind", "nevermind", "forget that", "forget it", "new question"]);
const ANCHORED = [/^start over\b/, /^never ?mind\b/, /^forget (?:that|it)\b/, /^new question\b/];
// The same phrases in the ORIGINAL text, to cut the rest off it unnormalised.
const ANCHORED_RAW = /\b(?:start\s+over|never\s*mind|forget\s+(?:that|it)|new\s+question)\b/i;

function normalize(text) {
  const t = (text ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(POLITE_PHRASES, " ");
  return t.split(/\s+/).filter((w) => w && !POLITE_WORDS.has(w)).join(" ");
}

// "start again" loses its "again" to POLITE_WORDS ("menu again"); keep the phrase itself.
const normalizeKeepingPhrases = (text) => normalize((text ?? "").replace(/\bstart\s+again\b/gi, "start_over_"));

/**
 * A control verb in `text`, or null. `{ verb: "reset" | "cancel", rest }` — `rest` is the
 * original remainder after an anchored phrase, to be answered after the reset.
 */
export function parseControl(text, { atIntake = false } = {}) {
  const n = normalizeKeepingPhrases(text).replace(/\bstart_over_\b/g, "start over");
  if (!n) return null;
  if (atIntake && n === "cancel") return { verb: "cancel", rest: null };
  if (WHOLE.has(n)) return { verb: "reset", rest: null };
  if (ANCHORED.some((p) => p.test(n))) {
    const m = (text ?? "").match(ANCHORED_RAW);
    const rest = m
      ? text
          .slice(m.index + m[0].length)
          .replace(/^[\s,.;:!?-]*(?:(?:please|pls|plz)\b[\s,.;:!?-]*)?/i, "")
          .trim()
      : "";
    return { verb: "reset", rest: rest || null };
  }
  return null;
}
