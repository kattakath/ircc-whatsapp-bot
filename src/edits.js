// Edits and deletes (docs/conversation-design.md FIX-14; S24, S25).
//
// Baileys reports an edit and a "delete for everyone" as `messages.update`, which index.js never
// handled (read: Utils/process-message.js, ProtocolMessage MESSAGE_EDIT and REVOKE). So an edited
// question kept its old answer, and a deleted queued message was still answered. Here:
// - a queued message's edit replaces its text before it is answered (S24);
// - an answered message's edit is re-answered only when the meaning changed; a typo fix gets
//   nothing (S24). The spec also names "same top retrieved source"; that needs a retrieval per
//   edit, so this first cut decides on the text alone (judgement call);
// - an edit that lands while the answer is in flight is re-answered right after it, if meaningful;
// - a deleted message still in the queue is never answered (S25). One already answered or in
//   flight cannot be un-sent: that residual is accepted.
// The update event carries the key and the new content, so no message store is needed.

const STOPWORDS = new Set(
  "a an the is are am was were be to of in on at for and or do does did can could i my me you your it this that please pls hi hello".split(" ")
);
const NEGATIONS = new Set("not no never dont cant wont isnt doesnt didnt without".split(" "));

const tokens = (t) =>
  (t ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** Words in `from` missing from `to`, as a multiset difference. */
function minus(from, to) {
  const left = [...to];
  return from.filter((w) => {
    const i = left.indexOf(w);
    if (i === -1) return true;
    left.splice(i, 1);
    return false;
  });
}

/**
 * Whether an edit changes the question's meaning. A typo fix (each changed word close to the word
 * it replaced), punctuation or a filler word does not. Any number, negation or new content word does.
 */
export function isMeaningfulEdit(before, after) {
  const b = tokens(before);
  const a = tokens(after);
  const added = minus(a, b);
  const removed = minus(b, a);
  const changed = [...added, ...removed];
  if (!changed.length) return false;
  if (changed.some((w) => /\d/.test(w) || NEGATIONS.has(w))) return true;
  const gone = removed.filter((w) => !STOPWORDS.has(w));
  for (const w of added.filter((x) => !STOPWORDS.has(x))) {
    const i = gone.findIndex((r) => levenshtein(w, r) <= Math.max(1, Math.floor(Math.max(w.length, r.length) / 3)));
    if (i === -1) return true;
    gone.splice(i, 1);
  }
  return gone.length > 0;
}

/** The new text of a Baileys MESSAGE_EDIT update, or null. */
export function editedText(update) {
  const m = update?.message?.editedMessage?.message;
  const t = m?.conversation ?? m?.extendedTextMessage?.text ?? m?.imageMessage?.caption ?? m?.videoMessage?.caption ?? null;
  return t && t.trim() ? t : null;
}

// WAMessageStubType.REVOKE is 1 (Baileys' proto); the update also clears the message.
export const isRevoke = (update) => !!update && update.message === null && update.messageStubType === 1;

function lru(limit) {
  const m = new Map();
  return {
    get: (k) => m.get(k),
    has: (k) => m.has(k),
    delete: (k) => m.delete(k),
    set(k, v) {
      m.delete(k);
      m.set(k, v);
      if (m.size > limit) m.delete(m.keys().next().value);
    },
    size: () => m.size,
  };
}

/**
 * Per-message edit/delete state, keyed by message id. `begin` when a text turn starts (returns the
 * text to answer: the latest edit if one arrived while queued), `finish` when it was answered
 * (returns an edited text to re-answer, or null), `fail` when it was not.
 */
export function createEditTracker({ limit = 1000 } = {}) {
  const answered = lru(limit); // id -> text that was answered
  const inflight = lru(limit); // id -> text being answered
  const pending = lru(limit); // id -> newest edit not yet answered
  const revoked = lru(limit);
  return {
    onRevoke(id) {
      revoked.set(id, true);
      pending.delete(id);
    },
    isRevoked: (id) => revoked.has(id),
    /** "reanswer" | "typo" | "pending" (queued, in flight or unknown: kept for begin/finish). */
    onEdit(id, text) {
      const before = answered.get(id);
      if (before !== undefined && !inflight.has(id)) {
        if (!isMeaningfulEdit(before, text)) return "typo";
        answered.set(id, text);
        return "reanswer";
      }
      pending.set(id, text);
      return "pending";
    },
    begin(id, text) {
      const edit = pending.get(id);
      pending.delete(id);
      const t = edit ?? text;
      inflight.set(id, t);
      return t;
    },
    finish(id, text) {
      inflight.delete(id);
      answered.set(id, text);
      const edit = pending.get(id);
      pending.delete(id);
      if (edit === undefined || !isMeaningfulEdit(text, edit)) return null;
      answered.set(id, edit);
      return edit;
    },
    fail(id) {
      inflight.delete(id);
    },
    size: () => answered.size() + inflight.size() + pending.size() + revoked.size(),
  };
}
