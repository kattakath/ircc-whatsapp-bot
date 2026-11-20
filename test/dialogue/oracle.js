// Layer L3 output oracle (docs/conversation-design.md §7): checks every bot reply for the
// formatting contract and grounding rules. Returns a list of violations; [] = clean.
// FIX-04's renderer is what makes real replies pass; until then the oracle is applied to
// stubbed replies and to known-bad samples.
const URL_RE = /https?:\/\/[^\s)>\]*_~]+/g;
export const URL_HOST_ALLOWLIST = [/^https:\/\/www\.canada\.ca\/en\/immigration-refugees-citizenship\//];
export const MAX_REPLY_CHARS = 1500;

export function checkReply(reply, { retrievedUrls = null, requireDisclaimer = false, maxChars = MAX_REPLY_CHARS } = {}) {
  const v = [];
  if (/\*\*[^*\n]+\*\*/.test(reply)) v.push("double-asterisk bold (WhatsApp shows literal stars)");
  if (/^\s{0,3}#{1,6}\s/m.test(reply)) v.push("markdown heading (# is literal on WhatsApp)");
  if (/^\s*\|.*\|\s*$/m.test(reply)) v.push("markdown table (unsupported on WhatsApp)");
  if (/^\s*\d+\.\s/m.test(reply)) v.push("line starting with a bare 'N.' (renders unreliably; use 'N)')");
  if (reply.length > maxChars) v.push(`longer than ${maxChars} chars (WhatsApp folds it behind Read more)`);
  for (const url of reply.match(URL_RE) ?? []) {
    if (!URL_HOST_ALLOWLIST.some((re) => re.test(url))) v.push(`URL outside the allowlist: ${url}`);
    else if (retrievedUrls && !retrievedUrls.includes(url)) v.push(`URL not among the retrieved sources: ${url}`);
  }
  if (requireDisclaimer && !/general info|not (official|legal|licensed)|RCIC|lawyer/i.test(reply)) v.push("missing the general-information disclaimer");
  return v;
}
