// Live IRCC data (docs/conversation-design.md FIX-20): processing times and Express Entry draws.
//
// The crawled processing-times page holds no durations (measured in the spec: zero in its first
// 4,000 chars) — the numbers live in JSON feeds the official tools load. Fetched and read
// 2026-11-20, all HTTP 200:
//   data-ptime-en.json        8 categories (visitor-outside-canada, supervisa, study, work,
//                             child_dependent, child_adopted, refugees_gov, refugees_private), each
//                             { <ISO2>: "N days|weeks|months" | "No processing time available" |
//                             "Not enough data", lastupdated: "November 18, 2026" }, ~212 countries.
//                             No Express Entry, PR or citizenship times are in it.
//   data-country-name-en.json { "country-name": { <ISO2>: name } } — starts with a UTF-8 BOM, and
//                             names carry HTML entities ("China (People&rsquo;s Republic of)").
//   ee_rounds_123_en.json     { rounds: [ { drawNumber, drawDate (ISO), drawDateFull, drawName,
//                             drawSize ("5,000"), drawCRS, … } ] }, newest first.
// The feeds are undocumented, so every read is schema-checked against that shape; on any doubt
// the reply abstains with the official link. Never a number from memory or from the corpus.

export const PTIME_TOOL_URL = "https://www.canada.ca/en/immigration-refugees-citizenship/services/application/check-processing-times.html";
export const EE_ROUNDS_URL =
  "https://www.canada.ca/en/immigration-refugees-citizenship/corporate/mandate/policies-operational-instructions-agreements/ministerial-instructions/express-entry-rounds.html";
const FEED = "https://www.canada.ca/content/dam/ircc/documents/json/";
const URLS = { ptime: `${FEED}data-ptime-en.json`, countries: `${FEED}data-country-name-en.json`, rounds: `${FEED}ee_rounds_123_en.json` };
const CACHE_MS = 60 * 60 * 1000; // the feeds change weekly at most (lastupdated); one fetch an hour
const FETCH_TIMEOUT_MS = 8_000;

const LABEL = {
  study: "Study permit",
  work: "Work permit",
  "visitor-outside-canada": "Visitor visa (applying from outside Canada)",
  supervisa: "Super visa",
};
// What a follow-up to "which country?" is phrased as, so liveIntent recognises it (clarify.js).
export const CATEGORY_PHRASE = { study: "study permit", work: "work permit", "visitor-outside-canada": "visitor visa", supervisa: "super visa" };

// --- intent (synchronous: used for routing) -------------------------------------------------

const PTIME_RE = /\b(processing times?|wait(?:ing)? times?)\b|\bhow long\b.*\b(take|takes|taking|process|processed|processing|to get)\b/i;
// "It's taking longer than the processing time — what can I do?" asks for help, not the estimate.
const DELAY_RE = /\bwhat (?:can|should|do) i do\b|\btaking (?:longer|too long|so long)\b|\b(?:delayed|stuck|overdue)\b/i;
const DRAW_RE = /\b(draws?|rounds?|cut-?offs?|invitations? to apply|itas?)\b/i;
const DRAW_CTX_RE = /\b(express entry|ee|crs|latest|last|recent|current|this week|today|newest)\b/i;

function categoryOf(t) {
  if (/\bsuper ?visa\b/i.test(t)) return "supervisa";
  if (/\b(study permit|student visa|study visa|to study)\b/i.test(t)) return "study";
  if (/\b(work permit|work visa)\b/i.test(t)) return "work";
  if (/\b(visitor visa|tourist visa|visit visa|visiting visa|trv)\b/i.test(t)) return "visitor-outside-canada";
  return null;
}
const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** { kind: "ptime", category, country|null } | { kind: "draws" } | null. Only covered categories. */
export function liveIntent(text) {
  const t = String(text ?? "").trim();
  if (DRAW_RE.test(t) && DRAW_CTX_RE.test(t)) return { kind: "draws" };
  if (!PTIME_RE.test(t) || DELAY_RE.test(t)) return null;
  const category = categoryOf(t);
  if (!category) return null;
  const m = t.replace(/[?.!]+$/, "").match(/\b(?:from|in)\s+([A-Za-z][A-Za-z.'()-]*(?:\s+[A-Za-z][A-Za-z.'()-]*){0,3})\s*$/);
  return { kind: "ptime", category, country: m ? titleCase(m[1]) : null };
}

// --- feeds -----------------------------------------------------------------------------------

const decode = (s) =>
  String(s)
    .replace(/&rsquo;|&#8217;/g, "’")
    .replace(/&amp;/g, "&")
    .replace(/&eacute;/g, "é")
    .replace(/&[a-z]+;/g, "");
const norm = (s) =>
  decode(s)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const ALIASES = { usa: "US", us: "US", america: "US", "united states": "US", uk: "GB", britain: "GB", england: "GB", "south korea": "KR", korea: "KR", uae: "AE", "the philippines": "PH", turkey: "TR" };
const VALUE_RE = /^(\d+ (days?|weeks?|months?)|No processing time available|Not enough data)$/;

function checkPtime(j) {
  const cats = ["study", "work", "visitor-outside-canada", "supervisa"];
  if (!j || typeof j !== "object" || !cats.every((c) => j[c] && typeof j[c] === "object")) throw new Error("ptime: categories missing");
  for (const c of cats) {
    if (typeof j[c].lastupdated !== "string" || !/\d{4}/.test(j[c].lastupdated)) throw new Error(`ptime: ${c} has no lastupdated`);
    const vals = Object.entries(j[c]).filter(([k]) => k !== "lastupdated").map(([, v]) => v);
    if (vals.length < 100) throw new Error(`ptime: ${c} has ${vals.length} countries`);
    const ok = vals.filter((v) => typeof v === "string" && VALUE_RE.test(v)).length;
    if (ok / vals.length < 0.8) throw new Error(`ptime: ${c} values do not match the known forms`);
  }
  return j;
}
function checkCountries(j) {
  const names = j?.["country-name"];
  if (!names || typeof names !== "object" || !Object.values(names).length || !Object.values(names).every((v) => typeof v === "string"))
    throw new Error("country names: unexpected shape");
  return names;
}
function checkRounds(j) {
  const rounds = j?.rounds;
  if (!Array.isArray(rounds) || !rounds.length) throw new Error("rounds: missing");
  for (const r of rounds.slice(0, 3)) {
    if (!/^\d+$/.test(r?.drawNumber ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(r?.drawDate ?? "") || !r?.drawName || !/^[\d,]+$/.test(r?.drawSize ?? "") || !/^\d+$/.test(r?.drawCRS ?? ""))
      throw new Error("rounds: unexpected draw shape");
  }
  return rounds;
}

/**
 * Live data with a fetch you can inject (tests). `answer(intent)` → reply text (never throws);
 * `hasCountry(name)` → whether `name` resolves to a country in IRCC's list (true if the list
 * cannot be loaded, so answer() abstains rather than asking again).
 */
export function createLiveData({ fetch: fetchImpl = globalThis.fetch, now = Date.now, logger = console } = {}) {
  const cache = new Map(); // url -> { at, value }
  async function load(name, check) {
    const url = URLS[name];
    const hit = cache.get(url);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const res = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ircc-whatsapp-bot/0.1)" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const value = check(JSON.parse((await res.text()).replace(/^﻿/, "")));
    cache.set(url, { at: now(), value });
    return value;
  }
  async function resolveCountry(name) {
    if (!name) return null;
    const names = await load("countries", checkCountries);
    const words = norm(name).split(" ");
    for (let k = words.length; k >= 1; k--) {
      const cand = words.slice(0, k).join(" ");
      if (ALIASES[cand]) return { code: ALIASES[cand], name: decode(names[ALIASES[cand]] ?? cand) };
      const code = Object.keys(names).find((c) => norm(names[c]) === cand);
      if (code) return { code, name: decode(names[code]).replace(/\s*\([^)]*\)/, "") };
    }
    return null;
  }
  async function hasCountry(name) {
    if (!name) return false;
    try {
      return !!(await resolveCountry(name));
    } catch {
      return true;
    }
  }
  async function answer(intent) {
    if (intent?.kind === "draws") {
      try {
        const rounds = await load("rounds", checkRounds);
        const lines = rounds.slice(0, 3).map((r) => `• #${r.drawNumber} · ${r.drawDateFull ?? r.drawDate} · ${decode(r.drawName)}: ${r.drawSize} invitations, CRS ${r.drawCRS}`);
        return `📊 *Latest Express Entry draws* (from IRCC):\n${lines.join("\n")}\n\n🔗 ${EE_ROUNDS_URL}`;
      } catch (err) {
        logger.error?.(`[live] draws unavailable: ${err.message}`);
        return `Sorry, I couldn't load IRCC's latest Express Entry draws right now. They're listed here:\n🔗 ${EE_ROUNDS_URL}`;
      }
    }
    try {
      const ptime = await load("ptime", checkPtime);
      const country = await resolveCountry(intent.country);
      const cat = ptime[intent.category];
      const label = LABEL[intent.category];
      if (!country) return `Which country are you applying from? IRCC's processing times differ by country.`;
      const value = cat[country.code];
      if (typeof value !== "string" || !/^\d/.test(value)) {
        return `IRCC has no current estimate for a ${label.toLowerCase()} from ${country.name} (updated ${cat.lastupdated}). The official tool may show more:\n🔗 ${PTIME_TOOL_URL}`;
      }
      return (
        `⏱️ *${label}, applying from ${country.name}:* about *${value}*\n` +
        `_IRCC's current estimate, updated ${cat.lastupdated}. It's how long most recent applications took, not a guarantee._\n\n` +
        `🔗 ${PTIME_TOOL_URL}`
      );
    } catch (err) {
      logger.error?.(`[live] processing times unavailable: ${err.message}`);
      return `Sorry, I couldn't load IRCC's live processing times right now. The official tool has them:\n🔗 ${PTIME_TOOL_URL}`;
    }
  }
  return { answer, hasCountry };
}
