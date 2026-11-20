// PII recognisers (docs/conversation-design.md FIX-07; PIPEDA Principle 5: limit use and
// retention). Same shape as Microsoft Presidio's pattern recognizers: a named regex, plus a
// context word where the bare pattern alone would misfire. The bot never needs any of these
// numbers to answer, so a message that carries one is not processed at all (src/index.js).

const RECOGNIZERS = [
  // UCI: 10 digits as 2-4-4 (the common form); an 8-digit UCI only next to its name.
  { kind: "UCI", re: /\b\d{2}-?\d{4}-?\d{4}\b/ },
  { kind: "UCI", re: /\b(?:uci|client\s*id)\b[^0-9]{0,20}\d{4}-?\d{4}\b/i },
  // SIN: 9 digits as 3-3-3. A 10-digit phone number (3-3-4) does not match.
  { kind: "SIN", re: /\b\d{3}[- ]\d{3}[- ]\d{3}\b|\b(?:sin|social insurance)\b[^0-9]{0,20}\d{9}\b/i },
  // IRCC application numbers: one letter + 9 digits (e.g. E001234567, W307654321).
  { kind: "application number", re: /\b[A-Z]\d{9}\b/i },
  // Passport numbers vary by country: only next to the word "passport".
  { kind: "passport number", re: /\bpassport\b.{0,25}?\b[A-Z]{1,2}\d{6,8}\b/i },
];

/** Kinds of identifier found in `text` (deduplicated, in recognizer order); [] = none. */
export function findSensitive(text) {
  const kinds = [];
  for (const { kind, re } of RECOGNIZERS) if (re.test(text) && !kinds.includes(kind)) kinds.push(kind);
  return kinds;
}

export const STATUS_URL = "https://www.canada.ca/en/immigration-refugees-citizenship/services/application/check-status.html";

/** The instant reply (S12): no lookup is possible, here is the official way, delete the message. */
export function sensitiveReply(kinds) {
  const what = kinds.length ? kinds.join(" / ") : "ID number";
  return (
    `⚠️ Please don't send your ${what} here — I can't look up your file, and I don't need it to help.\n` +
    `To check your application, sign in to your IRCC account or use the status tools: ${STATUS_URL}\n` +
    `Please delete that message, then ask your question again without the number.`
  );
}
