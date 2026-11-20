// One conversational turn for an ADMITTED sender (src/ingress.js decides that first).
//
// Extracted from index.js's processMessage so the offline dialogue harness can drive a
// real turn with fakes for every outbound channel (docs/conversation-design.md FIX-01,
// layer L2): `send(jid, content, options)` and `presence(state, jid)` are the only ways out, and
// the harness counts them per inbound message. Behaviour is unchanged from processMessage.
import { Command } from "@langchain/langgraph";
import { jidTag } from "./ingress.js";

// FIX-02: says what is happening and roughly how long, without claiming to be official.
export const FILLER_TEXT = "One sec — checking canada.ca, this usually takes about 30 seconds…";
export const ERROR_TEXT = "Sorry, something went wrong on my end — try again in a moment.";
export const OFFICIAL_LINK = "https://www.canada.ca/en/immigration-refugees-citizenship.html";
// FIX-03 repair: name the failed question, say it is saved, offer *again* and the official
// site — options, not a dead end (Ashktorab et al. CHI 2019; Google system-errors guidance).
export function repairText(question) {
  const q = question.length > 80 ? `${question.slice(0, 77)}…` : question;
  return `Sorry — I couldn't finish answering "${q}". It's saved: reply *again* to retry, or ask something else.\nOfficial info: ${OFFICIAL_LINK}`;
}
export const AGAIN_RE = /^\s*(?:(?:try|ask)\s+)?again\s*[.!?]*\s*$|^\s*retry\s*[.!?]*\s*$/i;
// Last failed question per chat, in memory only (lost on restart by design: nothing extra
// is persisted about the user).
const lastFailed = new Map();
// FIX-05: a captioned photo/document is answered from its caption, and says so.
export const CAPTION_PREFACE = "I can't open photos or files yet, so I'm answering from your caption.";
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
// `preface` (e.g. CAPTION_PREFACE) goes above the reply; `sendOptions` (e.g. the chat's
// ephemeralExpiration, FIX-05) rides on every message this turn sends.
export async function handleTurn({ jid, text, graph, send, presence, preface = null, sendOptions, now = Date.now, logger = console, failures = lastFailed }) {
  const failed = failures.get(jid);
  // *again* after a failure re-asks the saved question (FIX-03, S03).
  const question = failed && AGAIN_RE.test(text) ? failed.question : text;

  // Text-free logs (FIX-07): a hashed chat tag and a length, never the message or the number.
  logger.log(`[in]  #${jidTag(jid)} ${text.length} chars`);

  let answered = false;
  let presenceInterval = null;
  let fillerTimer = null;
  let snapshotForRollback = null;

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
        await send(jid, { text: FILLER_TEXT }, sendOptions);
      } catch (err) {
        logger.error("Failed to send slow-reply filler:", err);
      }
    }, FILLER_DELAY_MS);

    const config = { configurable: { thread_id: jid } };
    const snapshot = await graph.getState(config);
    snapshotForRollback = snapshot;
    const isFreshThread = snapshot.next.length === 0 || !!failed?.forceFresh;
    const isStale = snapshot.createdAt && now() - new Date(snapshot.createdAt).getTime() > STALE_MS;
    const input = isFreshThread || isStale ? { incomingText: question } : new Command({ resume: question });
    const result = await graph.invoke(input, config);

    const graphReply = result.__interrupt__?.[0]?.value;
    if (!graphReply) {
      // The graph always loops back to a node that interrupts; don't leave the user hanging if it ever doesn't.
      // No state dump in the message: it would carry the user's text into the log.
      throw new Error(`Graph returned no interrupt to reply with (keys: ${Object.keys(result ?? {}).join(",")})`);
    }

    failures.delete(jid);
    const reply = preface ? `${preface}\n\n${graphReply}` : graphReply;
    answered = true; // before sending, so a filler racing the reply cannot follow it
    logger.log(`[out] #${jidTag(jid)} ${reply.length} chars`);
    await send(jid, { text: reply }, sendOptions);
    return { reply };
  } catch (err) {
    logger.error("Error handling message:", err);
    // Atomic turn (FIX-03): a failed run leaves its input as a pending write on the head, so the
    // NEXT message used to be dropped and this question re-run. Fork a fresh checkpoint from the
    // pre-turn state (LangGraph time travel via updateState); a brand-new chat restarts instead.
    const preTurn = snapshotForRollback;
    let forceFresh = false;
    if (preTurn?.config?.configurable?.checkpoint_id) {
      try {
        await graph.updateState(preTurn.config, {});
      } catch (rollbackErr) {
        logger.error("Rollback to the pre-turn checkpoint failed:", rollbackErr);
        forceFresh = true;
      }
    } else {
      forceFresh = true;
    }
    failures.set(jid, { question, forceFresh });
    try {
      await send(jid, { text: repairText(question) }, sendOptions);
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
