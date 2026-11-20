// Content-based dedupe of resends (docs/conversation-design.md FIX-38, C19; S45, S54).
//
// On flaky data a person often resends the same question; each resend gets a new message id, so
// id dedupe (FIX-13) cannot see it, and every copy used to start a ~27 s RAG turn. Precedent:
// Amazon SQS FIFO content-based deduplication (a hash of the body within an interval). Scoped to
// free-text questions only: choices ("2"), slot answers, control words ("menu"), greetings and
// prods repeat legitimately and must never be absorbed (S54). The 10-minute window is a
// judgement call.
import { createHash } from "node:crypto";
import { classifyAct, isShortQuestion } from "./gate.js";

export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
export const ANSWERED_ABOVE = "I answered this just above.";

const normalize = (t) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** A free-text question that would go to RAG (never a choice, control word, greeting or prod). */
export function isDedupeCandidate(text) {
  const t = (text ?? "").trim();
  if (!t || /^\d+[.!]?$/.test(t) || /^(menu|restart|reset|start over|again|retry|more)\b/i.test(t)) return false;
  if (classifyAct(t)) return false;
  return t.length > 12 || isShortQuestion(t);
}

export function createDedupe({ windowMs = DEDUPE_WINDOW_MS, now = Date.now } = {}) {
  const entries = new Map(); // `${jid}|${hash}` -> { at, status: "inflight" | "answered", sent }
  const keyOf = (jid, text) => `${jid}|${createHash("sha256").update(normalize(text)).digest("hex").slice(0, 16)}`;
  function lookup(key) {
    const e = entries.get(key);
    if (!e) return null;
    if (now() - e.at > windowMs) {
      entries.delete(key);
      return null;
    }
    return e;
  }
  return {
    keyOf,
    /** "inflight" | "answered" | null */
    status: (key) => lookup(key)?.status ?? null,
    answered: (key) => lookup(key),
    start: (key) => entries.set(key, { at: now(), status: "inflight", sent: null }),
    finish: (key, sent) => entries.set(key, { at: now(), status: "answered", sent }),
    fail: (key) => entries.delete(key),
  };
}
