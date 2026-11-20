// Media without text (docs/conversation-design.md FIX-23, S10/S48). Allowlisted senders only
// (FIX-40 runs first). One fixed "type it" line used to answer every photo, voice note and
// sticker alike and ignore where the conversation was. Now each kind gets its own line, a pending
// intake question is restated so the slot stays in reach, a repeat is shorter (tapering, Google
// conversation design), and a sticker, usually a thank-you, gets no reply (judgement call).
// Reading the media itself (OCR, transcription) stays at P2 for privacy and compute.

const HIGH_STAKES_HINT = "If it mentions a refusal, a deadline or a hearing, contact a licensed consultant or lawyer soon.";

/**
 * The reply for a captionless media message, or null for none.
 * @param {{mediaType: string, pendingPrompt?: string|null, repeat?: boolean}} p
 */
export function mediaReply({ mediaType, pendingPrompt = null, repeat = false }) {
  if (mediaType === "sticker") return null;
  const voice = mediaType === "audio";
  if (repeat) return pendingPrompt ? `Please type it instead. ${pendingPrompt}` : "Please type it instead.";
  const lead = voice ? "I can't listen to voice notes yet — could you type it?" : "I can't open photos or files yet.";
  if (pendingPrompt) return `${lead} ${pendingPrompt}`;
  if (voice) return lead;
  return `${lead} If it's a letter from IRCC, type the part you have a question about (without any ID numbers) and I'll explain. ${HIGH_STAKES_HINT}`;
}
