// Compound questions (docs/conversation-design.md FIX-34, S43).
//
// One retrieval and one answer silently dropped the second and third question in "how much study
// permit fee and can my wife work and kids school free?", which reads as "no". Precedent for
// decomposition: Self-Ask (Press et al. 2022), LangChain query decomposition. The split here is a
// heuristic, not an LLM call (latency, §7). Its rules are judgement calls, guarded by negatives
// ("Can my wife and kids come with me?" is ONE question):
//   1. several "?" → one part each;
//   2. "what is X and Y and Z" where the items are short and include an acronym → one part each;
//   3. "… and <question word> …" splits when both sides are substantial;
//   4. "… and <family member> <2+ words>" splits when the left side is a question of 4+ words.
// At most 3 parts are answered; the rest is named so it is not silently dropped.

export const MAX_PARTS = 3;

const QWORD = /^(?:can|could|is|are|am|do|does|did|how|what|when|where|why|will|would|should|which|who)\b/i;
const FAMILY = /^(?:(?:my|our|the)\s+)?(?:kids?|children|child|son|daughter|wife|husband|spouse|partner|parents?|mother|father|mom|dad)\b/i;
const JOINER = /\s+(?:and|also|plus|&)\s+/gi;
const ACRONYM = /^[A-Z]{2,6}s?$/;
const LIST_LEAD = /^(what is|what's|what are|explain|meaning of|tell me about)\s+(.+)$/i;

const wc = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const clean = (s) => s.trim().replace(/[?.!,\s]+$/, "").trim();

function splitAcronymList(seg) {
  const m = seg.match(LIST_LEAD);
  if (!m) return null;
  const items = m[2].split(/\s*(?:,|&|\band\b)\s*/i).map(clean).filter(Boolean);
  if (items.length < 2 || items.some((i) => wc(i) > 2) || !items.some((i) => ACRONYM.test(i))) return null;
  return items.map((i) => ({ part: `${m[1]} ${i}`, name: i }));
}

function splitAnd(seg) {
  for (const m of seg.matchAll(JOINER)) {
    const left = seg.slice(0, m.index);
    const right = seg.slice(m.index + m[0].length);
    const fam = right.match(FAMILY);
    const byQuestion = QWORD.test(right) && wc(right) >= 3 && wc(left) >= 3;
    const byFamily = fam && wc(right.slice(fam[0].length)) >= 2 && wc(left) >= 4 && (QWORD.test(left) || /^how much\b/i.test(left));
    if (byQuestion || byFamily) return [...splitAnd(clean(left)), ...splitAnd(clean(right))];
  }
  return [{ part: clean(seg), name: clean(seg) }];
}

/** `{ parts, rest }`: up to MAX_PARTS sub-questions, and the names of any beyond that. */
export function splitCompound(question) {
  const segs = String(question ?? "")
    .split(/\?\s+(?=\S)/)
    .map(clean)
    .filter(Boolean);
  const all = segs.flatMap((s) => splitAcronymList(s) ?? splitAnd(s)).filter((p) => p.part);
  if (all.length <= 1) return { parts: [clean(String(question ?? ""))], rest: [] };
  return { parts: all.slice(0, MAX_PARTS).map((p) => p.part), rest: all.slice(MAX_PARTS).map((p) => p.name) };
}

/** "You also asked about X — send it next and I'll answer it." (or null). */
export function restNote(rest) {
  if (!rest?.length) return null;
  const names = rest.length === 1 ? rest[0] : `${rest.slice(0, -1).join(", ")} and ${rest.at(-1)}`;
  return rest.length === 1
    ? `You also asked about ${names} — send it next and I'll answer it.`
    : `You also asked about ${names} — send them next and I'll answer them.`;
}

/** The single synthesis question for several parts: one short section each. */
export function compoundQuestion(parts) {
  return (
    `This message asks ${parts.length} things. Answer each in its own short section with a bold heading, ` +
    `at most 2 bullets each:\n${parts.map((p, i) => `${i + 1}) ${p}`).join("\n")}`
  );
}
