// Single writer per chat across reconnects (docs/conversation-design.md FIX-21).
//
// A Baileys reconnect builds a NEW socket. index.js used to rebuild its per-chat queues with it,
// so a turn still running on the old queue and a new message on the new queue could run the same
// LangGraph thread concurrently, and an answer finished while the socket was down was lost.
// Here the queues live for the whole process, the socket sits in a swappable holder, and a send
// that cannot go out now waits in an in-memory outbox (the transactional-outbox pattern, in
// memory: loss on process exit is accepted, open question 16). On reconnect each chat gets at
// most ONE combined message, never a burst.

/** A holder whose socket is swapped on reconnect; `ready` is true only while connected. */
export function createHolder() {
  return { sock: null, ready: false };
}

/** Per-chat serial queue that survives socket swaps (one writer per chat). */
export function createQueues() {
  const queues = new Map();
  return function enqueue(jid, task) {
    const prev = queues.get(jid) ?? Promise.resolve();
    const next = prev.then(task, task);
    queues.set(jid, next.catch(() => {}));
    return next;
  };
}

const isConnectionError = (err) =>
  /connection (closed|lost)|not open|socket|ECONN|EPIPE|timed out/i.test(String(err?.message ?? err)) ||
  [408, 428, 440, 500, 503, 515].includes(err?.output?.statusCode);

/**
 * send(jid, content, options) through whatever socket is current. While disconnected, or if the
 * send fails on a connection error, the message waits in `outbox` and `undefined` is returned.
 */
// `dropOnFlush`: texts that only mattered at the time (e.g. the "One sec" filler) and must not
// be prefixed to a real answer after a reconnect.
export function createSender(holder, outbox = new Map(), logger = console, { dropOnFlush = [] } = {}) {
  function park(jid, content, options) {
    const list = outbox.get(jid) ?? [];
    list.push({ content, options });
    outbox.set(jid, list);
  }
  async function send(jid, content, options) {
    if (!holder.ready || !holder.sock) {
      park(jid, content, options);
      return undefined;
    }
    try {
      return await holder.sock.sendMessage(jid, content, options);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      logger.error(`[outbox] send failed on a connection error; held for reconnect: ${err.message}`);
      park(jid, content, options);
      return undefined;
    }
  }
  async function presence(state, jid) {
    if (!holder.ready || !holder.sock) return; // a presence update is not worth holding
    try {
      await holder.sock.sendPresenceUpdate(state, jid);
    } catch {
      /* best-effort */
    }
  }
  /** On reconnect: at most ONE message per chat, the held texts joined in order. */
  async function flush() {
    for (const [jid, list] of [...outbox.entries()]) {
      outbox.delete(jid);
      const text = list
        .map((m) => m.content?.text)
        .filter((t) => t && !dropOnFlush.includes(t))
        .join("\n\n");
      if (!text) continue;
      const options = list.at(-1).options;
      try {
        await holder.sock.sendMessage(jid, { text }, options);
      } catch (err) {
        logger.error(`[outbox] flush failed, holding again: ${err.message}`);
        outbox.set(jid, [{ content: { text }, options }]);
      }
    }
  }
  return { send, presence, flush, outbox };
}
