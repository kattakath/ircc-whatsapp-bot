import OpenAI from "openai";

// Per-call deadline (FIX-03): the SDK default is 600 s x 3 attempts, far beyond what a
// person on WhatsApp will wait. One call is bounded here; a transient failure is retried
// once at the graph node (retryPolicy in graph.js), not inside the SDK as well.
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: Number(process.env.OPENAI_TIMEOUT_MS ?? 90_000),
  maxRetries: 0,
});
// Deliberately NOT the "-pro" tier: that's the highest-intelligence option
// but takes 30-90s, which the system-audit found to be in direct tension
// with this audience (W3C COGA flags cognitive fatigue during multi-step
// waits) — a few-second reply that keeps her engaged beats marginally
// deeper reasoning she may never come back to read. Still uses the
// Responses API (client.responses.create, not chat.completions) since
// that's a superset that works for every tier, "-pro" included, so
// switching back up later is just this one string.
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.5";

export const SYSTEM_PROMPT = `You are a friendly helper explaining Canadian immigration (IRCC) topics
to someone who is not fluent in bureaucratic or legal language, over WhatsApp.

Rules:
- Answer ONLY using the "Retrieved IRCC content" you are given. Do not add
  facts from general knowledge, and do not guess at numbers, dates, or fees
  that aren't in the retrieved content.
- If the retrieved content doesn't actually answer the question, say so
  plainly instead of filling the gap with a guess.
- Write short, plain sentences. No legal jargon. Explain any term you must
  use (e.g. "CRS" -> "Comprehensive Ranking System, a points score IRCC
  uses for Express Entry").
- You are talking directly with the person asking (a WhatsApp chat).
  Address them as "you" — never "she"/"her friend"/third person — even
  when the question is phrased as "My profile: ...".
- Always answer in English, even if the question was asked in another
  language — the retrieved content is English-only, and translating it on
  the fly risks losing accuracy. If the question was clearly in another
  language, briefly acknowledge that in English (e.g. "Answering in
  English since that's what I can check against official sources:") rather
  than silently switching languages or ignoring the mismatch.

Format for WhatsApp, chatbot-UX style (short scannable chunks, not prose
paragraphs — this is the established chatbot/conversational-UI writing
pattern, not a stylistic add-on):
- Break the answer into bullet points (one idea per line) instead of
  paragraphs, unless it's a single short fact that doesn't need bullets.
- Use a relevant emoji as a visual anchor at the start of each bullet where
  it fits naturally (✅ 📌 🍁 🛂 📅 etc.) — don't force one onto every line
  if it feels awkward.
- Write plain standard Markdown (**bold** for key terms, "-" bullets,
  "1." steps when order matters). The app converts it for WhatsApp.
- Keep the whole answer under ~180 words unless the question genuinely
  needs a longer breakdown (e.g. a multi-factor eligibility comparison) —
  even then, prefer more bullets over longer sentences.
- End with a one-line reminder that this is general information, not
  official or licensed immigration advice, and for anything that affects a
  real application they should double check on canada.ca or with a
  licensed professional (RCIC/lawyer).
- Cite the retrieved content you used by its number in square brackets,
  like [1] or [2], right after the fact it supports. Do NOT write any URLs
  or web addresses: the app adds the official source links itself.`;

// High-stakes language — a refusal, deadline, or removal proceeding is a
// materially different situation from "how do I apply": a wrong or
// incomplete answer here can have real consequences, and industry practice
// for legal-adjacent chatbots is to escalate explicitly rather than repeat
// the same soft footer used for routine questions. Kept high-precision
// (specific terms, not broad topic words) to avoid over-triggering.
const HIGH_STAKES_PATTERN =
  /\b(refused|refusal|rejected|denied|denial|appeal|deported|deportation|removal order|inadmissible|inadmissibility|detained|detention|misrepresentation|overstayed|overstay|expired status|status (?:has |had |is |was )?(?:expired|ended)|out of status|lost (?:my |our |his |her |their )?status|(?:visa|permit|visitor record) (?:has |had |is |was )?expired|procedural fairness|humanitarian and compassionate|deadline|missed my|running out of time)\b/i;

export function isHighStakes(text) {
  return HIGH_STAKES_PATTERN.test(text);
}

const HIGH_STAKES_NOTE =
  "\n\nIMPORTANT — this question involves a refusal, deadline, appeal, " +
  "inadmissibility, detention, or similar high-stakes situation where an " +
  "incomplete answer could have real consequences. After any general " +
  "information you can honestly give from the retrieved content, replace " +
  "the usual soft one-line disclaimer with an explicit, direct recommendation " +
  "to contact a licensed RCIC or immigration lawyer as soon as possible — " +
  "and if a deadline is mentioned, say plainly that time matters and they " +
  "should not wait to get professional help.";

/**
 * chunks: [{ content, metadata, similarity, live? }]
 * Returns a plain-text answer suitable for a WhatsApp message.
 */
export async function synthesize(question, chunks) {
  const highStakes = isHighStakes(question);

  if (!chunks || chunks.length === 0) {
    if (highStakes) {
      return (
        "I don't have official IRCC content covering the specifics of this, and this sounds like " +
        "a situation (refusal, deadline, appeal, or similar) where getting it wrong matters. " +
        "Please contact a licensed RCIC or immigration lawyer as soon as possible rather than " +
        "relying on me here — if there's a deadline, don't wait."
      );
    }
    return (
      "I don't have official IRCC content covering that specific question yet, " +
      "so I don't want to guess. Try rephrasing, or ask something about " +
      "citizenship, Express Entry/PR, study permits, work permits, or visiting Canada " +
      "— and I can also fetch a specific IRCC page if you tell me the exact topic."
    );
  }

  const context = chunks
    .map((c, i) => {
      // `live` marks CRAG web-fallback chunks (websearch.js); a retrieved
      // chunk with no similarity is a keyword-only hit from the hybrid index.
      const provenance = c.live
        ? "live canada.ca search"
        : c.similarity == null
          ? "keyword match"
          : `similarity ${c.similarity.toFixed(2)}`;
      return (
        // No URL here (FIX-04): links are rendered by code from metadata, never copied by the model.
        `[${i + 1}] (${provenance}) ${c.metadata.title ?? ""}\n${c.content}`
      );
    })
    .join("\n\n");

  const response = await client.responses.create({
    model: MODEL,
    instructions: SYSTEM_PROMPT,
    input:
      `Question: ${question}\n\nRetrieved IRCC content:\n${context}` +
      (highStakes ? HIGH_STAKES_NOTE : ""),
  });

  return response.output_text.trim();
}
