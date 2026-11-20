// Deterministic WhatsApp renderer (docs/conversation-design.md FIX-04, §6 "formatting contract").
//
// The model writes standard Markdown; CODE turns it into WhatsApp's dialect, so a model that
// ignores formatting rules (live: `**double**` reached the phone) still renders correctly.
// Parsing uses marked's lexer (off-the-shelf CommonMark/GFM, pinned in package.json) rather than
// hand-written regexes. Source links are rendered by code from retrieved metadata; any URL the
// model typed itself is dropped unless it is exactly a retrieved canada.ca URL (an eval caught
// an invented "canadaca.ca"; ALCE, Gao et al. 2023: ~50% of model citations lack support).
import { Lexer } from "marked";

const ALLOWED_HOST = "www.canada.ca";
const URL_RE = /https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"*_~]/g;

export const metrics = { droppedUrls: 0, zeroMarkerAnswers: 0 };

function inline(tokens = [], ctx) {
  return tokens
    .map((t) => {
      switch (t.type) {
        case "strong":
          return wrap("*", inline(t.tokens, ctx));
        case "em":
          return wrap("_", inline(t.tokens, ctx));
        case "del":
          return wrap("~", inline(t.tokens, ctx));
        case "codespan":
          return t.text; // backtick rendering varies by client: plain text
        case "link": {
          // URL policy at the token: an autolink is the URL itself; a named link keeps its text.
          const label = inline(t.tokens, ctx);
          const ok = ctx.allow(t.href);
          if (!ok) ctx.dropped += 1;
          if (label === t.href || label === t.text && t.text === t.href) return ok ? t.href : "";
          return ok ? `${label}: ${t.href}` : label;
        }
        case "image":
          return t.text ?? "";
        case "br":
          return "\n";
        case "html":
          return "";
        case "escape":
          return t.text;
        case "text":
          return t.tokens ? inline(t.tokens, ctx) : t.text;
        default:
          return t.raw ?? "";
      }
    })
    .join("");
}

// WhatsApp markers only work hugging the text: "*x*", never "* x *" or "**".
function wrap(marker, s) {
  const inner = s.trim();
  return inner ? `${marker}${inner}${marker}` : "";
}

function block(t, ctx) {
  switch (t.type) {
    case "heading":
      return wrap("*", inline(t.tokens, ctx));
    case "paragraph":
      return inline(t.tokens, ctx);
    case "list":
      return t.items
        .map((item, i) => {
          const body = item.tokens.map((x) => (x.type === "text" || x.type === "paragraph" ? inline(x.tokens ?? [x], ctx) : block(x, ctx))).join("\n").trim();
          // Never a bare leading digit: a bare "1" from the user means a menu choice.
          return t.ordered ? `Step ${(Number(t.start) || 1) + i}: ${body}` : `• ${body}`;
        })
        .join("\n");
    case "table": {
      const head = t.header.map((c) => inline(c.tokens, ctx)).join(" — ");
      const rows = t.rows.map((r) => `• ${r.map((c) => inline(c.tokens, ctx)).join(" — ")}`);
      return [wrap("*", head), ...rows].join("\n");
    }
    case "code":
      return t.text;
    case "blockquote":
      return t.tokens.map((x) => block(x, ctx)).join("\n");
    case "html":
      return t.text.replace(/<[^>]+>/g, "").trim();
    case "hr":
    case "space":
      return "";
    default:
      return t.raw ?? "";
  }
}

/** Standard Markdown → WhatsApp text. `allow(url)` decides which URLs survive (default: all). */
export function toWhatsApp(markdown, ctx = { allow: () => true, dropped: 0 }) {
  const out = new Lexer({ gfm: true }).lex(markdown ?? "").map((t) => block(t, ctx)).filter((s) => s !== "").join("\n\n");
  return out
    .replace(/\*\*+/g, "*") // a leftover run of asterisks from unbalanced markup
    .replace(/__+/g, "_")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // a heading the lexer saw as text (e.g. mid-paragraph)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Valid [n] markers (1-based, within the chunk list) in order of first use. */
export function citedIndexes(text, count) {
  const seen = [];
  for (const m of String(text).matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= count && !seen.includes(n)) seen.push(n);
  }
  return seen;
}

function isAllowedSource(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === ALLOWED_HOST;
  } catch {
    return false;
  }
}

/**
 * Render a model answer for WhatsApp and attach code-rendered sources.
 * Sources: the chunks the model cited as [n]; with no valid markers, the top 2 retrieved by
 * grade (abstaining on zero markers stays OFF until open question 9 measures gpt-oss's [n] rate).
 * Returns { text, sources, dropped, zeroMarkers }.
 */
export function renderAnswer(markdown, chunks = []) {
  // gpt-oss also cites in its own full-width form, 【1】 or 【1†L3-L5】 (seen live 2026-11-20):
  // fold it into [n] first, so it picks sources and is stripped like any other marker.
  markdown = String(markdown ?? "").replace(/【(\d{1,2})(?:†[^】]*)?】/g, "[$1]");
  const allowed = new Set(chunks.map((c) => c?.metadata?.url).filter((u) => u && isAllowedSource(u)));
  const ctx = { allow: (u) => allowed.has(u), dropped: 0 };
  // Links are judged at the token; a bare URL that survived as plain text is judged here.
  const body = toWhatsApp(markdown, ctx)
    .replace(URL_RE, (url) => {
      if (allowed.has(url)) return url;
      ctx.dropped += 1;
      return "";
    })
    .replace(/\s+([.,;:!?])/g, "$1") // "See ." left behind by a dropped URL
    .replace(/(^|[.!?]\s+)(?:See|Visit|Go to)\s*[.:]?\s*$/gm, "$1") // a sentence that only pointed at a dropped URL
    .trim();
  const dropped = ctx.dropped;

  const cited = citedIndexes(markdown, chunks.length);
  const zeroMarkers = cited.length === 0;
  const pick = zeroMarkers
    ? [...chunks.keys()].sort((a, b) => (chunks[b].similarity ?? 0) - (chunks[a].similarity ?? 0)).map((i) => i + 1)
    : cited;
  const sources = [];
  for (const n of pick) {
    const url = chunks[n - 1]?.metadata?.url;
    if (url && isAllowedSource(url) && !sources.includes(url)) sources.push(url);
    if (sources.length === 2) break;
  }

  metrics.droppedUrls += dropped;
  if (zeroMarkers && chunks.length) metrics.zeroMarkerAnswers += 1;

  // [n] markers only pick the sources (above); the reader never sees them. A marker the model put
  // on its own line ("[2]") would otherwise leave a stray line (seen live on gpt-oss:20b).
  const tidy = body
    // gpt-oss also puts no-break spaces (U+00A0, U+202F) around markers: "intake\u00a0【1】." (seen live).
    .replace(/[ \t\u00a0\u202f]*\[\d{1,2}\](?:[ \t\u00a0\u202f]*\[\d{1,2}\])*/g, "")
    // After the strip, not before: "no fee [3] ." must become "no fee." (seen live).
    .replace(/[ \t\u00a0\u202f]+([.,;:!?])(?=\s|$)/g, "$1")
    .replace(/[ \t\u00a0\u202f]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const text = sources.length ? `${tidy}\n\n${sources.map((u) => `🔗 ${u}`).join("\n")}` : tidy;
  return { text, body: tidy, sources, dropped, zeroMarkers };
}
