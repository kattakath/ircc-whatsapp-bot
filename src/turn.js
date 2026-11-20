// One conversational turn for an ADMITTED sender (src/ingress.js decides that first).
//
// Extracted from index.js's processMessage so the offline dialogue harness can drive a
// real turn with fakes for every outbound channel (docs/conversation-design.md FIX-01,
// layer L2): `send(jid, content)` and `presence(state, jid)` are the only ways out, and
// the harness counts them per inbound message. Behaviour is unchanged from processMessage.
import { Command } from "@langchain/langgraph";

export const FILLER_TEXT = "One sec — checking the official IRCC info... 🍁";
export const ERROR_TEXT = "Sorry, something went wrong on my end — try again in a moment.";
export const FILLER_DELAY_MS = 4000;
export const PRESENCE_REFRESH_MS = 8000;
// A conversation abandoned mid-intake for a week+ starts fresh instead of resuming stale
// slot answers. createdAt is the last checkpoint's timestamp.
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {object} p
 * @param {string} p.jid
 * @param {string} p.text
 * @param {{getState: Function, invoke: Function}} p.graph  a compiled LangGraph
 * @param {(jid: string, content: object) => Promise<any>} p.send
 * @param {(state: string, jid: string) => Promise<any>} p.presence
 * @param {() => number} [p.now]
 * @param {{log: Function, error: Function}} [p.logger]
 */
export async function handleTurn({ jid, text, graph, send, presence, now = Date.now, logger = console }) {
  logger.log(`[in]  ${jid}: ${text}`);

  let answered = false;
  let presenceInterval = null;
  let fillerTimer = null;

  try {
    await presence("composing", jid);

    // WhatsApp's "composing" indicator has a short TTL (~10-25s) and silently
    // disappears if not refreshed, so keep refreshing it until the reply lands.
    // Timers live here, not in a graph node: a node re-executes from its top on
    // resume-after-crash, so a side effect before its interrupt() would double-fire.
    presenceInterval = setInterval(() => {
      if (answered) return;
      presence("composing", jid).catch((err) => logger.error("Failed to refresh composing presence:", err));
    }, PRESENCE_REFRESH_MS);

    fillerTimer = setTimeout(async () => {
      if (answered) return; // avoid a filler landing just after the real reply
      try {
        await send(jid, { text: FILLER_TEXT });
      } catch (err) {
        logger.error("Failed to send slow-reply filler:", err);
      }
    }, FILLER_DELAY_MS);

    const config = { configurable: { thread_id: jid } };
    const snapshot = await graph.getState(config);
    const isFreshThread = snapshot.next.length === 0;
    const isStale = snapshot.createdAt && now() - new Date(snapshot.createdAt).getTime() > STALE_MS;
    const input = isFreshThread || isStale ? { incomingText: text } : new Command({ resume: text });
    const result = await graph.invoke(input, config);

    const reply = result.__interrupt__?.[0]?.value;
    if (!reply) {
      // The graph always loops back to a node that interrupts; don't leave the user hanging if it ever doesn't.
      throw new Error(`Graph returned no interrupt to reply with: ${JSON.stringify(result)}`);
    }

    answered = true; // before sending, so a filler racing the reply cannot follow it
    logger.log(`[out] ${jid}: ${reply.slice(0, 120)}${reply.length > 120 ? "..." : ""}`);
    await send(jid, { text: reply });
    return { reply };
  } catch (err) {
    logger.error("Error handling message:", err);
    try {
      await send(jid, { text: ERROR_TEXT });
    } catch (sendErr) {
      logger.error("Also failed to send the error reply:", sendErr);
    }
    return { error: err };
  } finally {
    answered = true;
    if (fillerTimer) clearTimeout(fillerTimer);
    if (presenceInterval) clearInterval(presenceInterval);
  }
}
