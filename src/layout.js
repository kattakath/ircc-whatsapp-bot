// Answer layout, owned by code (docs/conversation-design.md FIX-18, §6 "Message layout"; S35, S36).
//
// Measured 2026-11-20: WhatsApp folds a message behind "Read more" after ~755-764 characters
// (three live answers: 764, 759, 755), and the 44-question eval's answer bodies have a median of
// 790 chars (p75 962). A cap under the fold (600) would split 26/44 answers into two messages, a
// round trip each, where "Read more" costs one tap; the spec's 950 splits 13/44. So the body cap
// stays 950 and what MUST be seen goes to the TOP instead: the strong high-stakes block leads the
// message (graph.js also leads a mid-intake side answer with a "paused" line). After the body:
// "Want more? Reply *more*" (only when it overflowed), the disclaimer, then source links.
// The overflow is kept for "more" (graph.js).
//
// The disclaimer is appended by code, tiered: full on the first answer of a session, a short
// footer after that, and for a high-stakes question (isHighStakes) a strong block with the
// licensed-representative register link. The model's own trailing disclaimer (the prompt still
// asks for one) is stripped so it never appears twice.

import { REPRESENTATIVE_URL } from "./gate.js";

export const BODY_CAP = 950;
export const MORE_LINE = "Want more? Reply *more*.";
export const DISCLAIMER = {
  short: "_General info, not legal advice._",
  full: "_General info from canada.ca, not legal advice. For your own application, check with a licensed consultant or lawyer._",
  strong:
    "⚠️ *This can affect your status.* Please talk to a licensed consultant (RCIC) or lawyer soon. If there's a deadline, don't wait.\n" +
    `🔗 ${REPRESENTATIVE_URL}`,
};

// A last paragraph that is only the model's "general information / licensed professional" line.
const DISCLAIMER_RE = /general (?:info|information)|not (?:official|legal|licensed)|legal advice|double[- ]?check|licensed (?:professional|immigration|consultant|rcic)|\brcic\b/i;

export function stripModelDisclaimer(body) {
  const paras = String(body ?? "").trim().split(/\n{2,}/);
  if (paras.length < 2) return paras.join("\n\n");
  const last = paras.at(-1);
  if (last.length <= 350 && DISCLAIMER_RE.test(last)) paras.pop();
  return paras.join("\n\n").trim();
}

// A heading line: bold-only ("*📌 Next steps*") or ending with a colon.
const isHeading = (line) => /^\*[^*]+\*$/.test(line.trim()) || /:\s*$/.test(line.trim());

/** Split `body` at a line boundary so `head` ≤ cap; a trailing heading moves to `rest`. */
export function splitAtCap(body, cap) {
  const text = String(body ?? "").trim();
  if (text.length <= cap) return { head: text, rest: "" };
  const lines = text.split("\n");
  const head = [];
  let len = 0;
  for (const line of lines) {
    const add = (head.length ? 1 : 0) + line.length;
    if (len + add > cap) break;
    head.push(line);
    len += add;
  }
  if (!head.length) {
    // One line longer than the cap: cut at the last sentence end, or space, before it.
    const cut = text.slice(0, cap);
    const at = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
    const n = at > cap / 2 ? at + 1 : cap;
    return { head: text.slice(0, n).trim(), rest: text.slice(n).trim() };
  }
  while (head.length > 1 && (head.at(-1).trim() === "" || isHeading(head.at(-1)))) head.pop();
  return { head: head.join("\n").trim(), rest: lines.slice(head.length).join("\n").trim() };
}

/**
 * Compose one answer message. `tier`: "short" | "full" | "strong".
 * Returns { text, remainder } — remainder is the overflow ("" when none), kept for "more".
 */
export function layoutAnswer({ body, sources = [], tier = "short", after = null }) {
  const clean = stripModelDisclaimer(body);
  const { head, rest } = splitAtCap(clean, BODY_CAP);
  const strong = tier === "strong";
  const parts = strong ? [DISCLAIMER.strong, head] : [head]; // high stakes: the warning leads
  if (rest) parts.push(MORE_LINE);
  if (after) parts.push(after); // e.g. "Continue the PR check…, or stop?"
  if (!strong) parts.push(DISCLAIMER[tier] ?? DISCLAIMER.short);
  if (sources.length) parts.push(sources.map((u) => `🔗 ${u}`).join("\n"));
  return { text: parts.join("\n\n"), remainder: rest };
}

/** The next "more" message from a stored remainder: { text, remainder }. */
export function nextChunk(remainder) {
  const { head, rest } = splitAtCap(remainder, BODY_CAP);
  return { text: rest ? `${head}\n\n${MORE_LINE}` : head, remainder: rest };
}

// "more", "pls continue", "tell me more", "rest?" — the WHOLE message, after politeness words.
// "more about PGWP" is a new question (S35).
const MORE_WORDS = new Set(["more", "tell more", "tell me more", "continue", "go on", "keep going", "the rest", "rest", "next", "say more", "show more", "read more", "and", "more details", "more info"]);
export function isMoreRequest(text) {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !["please", "pls", "plz", "ok", "okay", "can", "you", "could"].includes(w))
    .join(" ");
  return MORE_WORDS.has(t);
}
