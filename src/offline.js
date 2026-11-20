// Messages that arrived while the bot was offline (docs/conversation-design.md FIX-13, S23).
//
// Baileys delivers them on reconnect as messages.upsert type "append" (already receipted), and
// index.js used to drop every "append": the user saw two grey ticks, then silence. "append" is
// also emitted for newsletters, our own sends and offline calls (read: messages-recv.js,
// messages-send.js), hence an explicit acceptance predicate. Within the window each message is
// answered late, saying so and quoting it; beyond it, ONE note per chat. Never silence, never a
// burst. Dedupe by key.id (the idempotent-consumer pattern) because the same message can come
// again as "notify".

// Judgement call: half an hour is still "a moment ago" for a question; older ones may no longer
// be what the person needs, so they get one note instead of a stale answer.
export const OFFLINE_WINDOW_MS = 30 * 60 * 1000;
export const OFFLINE_PREFACE = "Sorry, I was offline for a bit.";
export const OFFLINE_NOTE = "Sorry, I was offline — I saw your messages from earlier. Send the one you still need again.";

/** A real person's 1:1 message: not ours, not a group, newsletter, broadcast or call. */
export function acceptInbound(msg) {
  const jid = msg?.key?.remoteJid ?? "";
  if (!msg?.message || msg.key.fromMe) return false;
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

/** Bounded set of seen message ids (insertion-ordered Map as an LRU). */
export function createSeen(limit = 2000) {
  const ids = new Map();
  return {
    has: (id) => ids.has(id),
    add(id) {
      ids.delete(id);
      ids.set(id, true);
      if (ids.size > limit) ids.delete(ids.keys().next().value);
    },
  };
}

/**
 * Split one chat's offline backlog: messages inside the window are answered; anything older
 * gets one note that quotes the newest of them. `messageTimestamp` is in seconds.
 */
export function planBacklog(msgs, now = Date.now(), windowMs = OFFLINE_WINDOW_MS) {
  const answer = [];
  const old = [];
  for (const m of msgs) {
    const sentAt = Number(m.messageTimestamp ?? 0) * 1000;
    (now - sentAt <= windowMs ? answer : old).push(m);
  }
  return { answer, noteFor: old.at(-1) ?? null };
}
