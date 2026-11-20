// FIX-18: code-owned answer layout — body cap below WhatsApp's fold, tiered disclaimer, remainder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BODY_CAP, DISCLAIMER, MORE_LINE, layoutAnswer, splitAtCap, stripModelDisclaimer } from "../src/layout.js";

const bullets = (n) => Array.from({ length: n }, (_, i) => `• Bullet ${i + 1}: ${"x".repeat(80)}`).join("\n");

test("the model's own trailing disclaimer is stripped; body content mentioning a consultant is kept", () => {
  const body = "✅ The fee is $150.\n\n• Pay online.\n\n⚠️ This is general information. For the exact fee, check canada.ca or consult a licensed immigration professional.";
  assert.equal(stripModelDisclaimer(body), "✅ The fee is $150.\n\n• Pay online.");
  const live = "✅ No.\n\n• Something.\n\n_This is general info only – for a real application check canada.ca or speak with a licensed professional._";
  assert.equal(stripModelDisclaimer(live), "✅ No.\n\n• Something.");
  const keep = "✅ Hire a licensed consultant (RCIC) to represent you.\n\n• Step two.";
  assert.equal(stripModelDisclaimer(keep), keep, "not the last paragraph: kept");
});

test("splitAtCap cuts at a line boundary under the cap and never ends on a heading", () => {
  const body = `✅ Yes, you can.\n\n${bullets(6)}\n\n*📌 Next steps*\n${bullets(6)}`;
  const { head, rest } = splitAtCap(body, BODY_CAP);
  assert.ok(head.length <= BODY_CAP, `head ${head.length}`);
  assert.ok(rest.length > 0);
  assert.ok(!/\*📌 Next steps\*\s*$/.test(head), "a heading is moved to the remainder");
  assert.deepEqual(splitAtCap("short", BODY_CAP), { head: "short", rest: "" });
});

test("layout: body (capped), 'Want more', disclaimer, sources — in that order", () => {
  const out = layoutAnswer({ body: `✅ Yes.\n\n${bullets(20)}`, sources: ["https://www.canada.ca/en/a.html", "https://www.canada.ca/en/b.html"], tier: "short" });
  const iMore = out.text.indexOf(MORE_LINE);
  const iDisc = out.text.indexOf(DISCLAIMER.short);
  const iSrc = out.text.indexOf("🔗 https://www.canada.ca/en/a.html");
  assert.ok(iMore > 0 && iMore < iDisc && iDisc < iSrc, "order");
  assert.ok(out.remainder.includes("Bullet 20"));
  const short = layoutAnswer({ body: "✅ Yes.", sources: [], tier: "full" });
  assert.equal(short.remainder, "");
  assert.ok(!short.text.includes(MORE_LINE));
  assert.ok(short.text.includes(DISCLAIMER.full));
});

test("high stakes: the strong block with the register link LEADS the message (above WhatsApp's fold)", () => {
  const out = layoutAnswer({ body: `✅ Act now.\n\n${bullets(20)}`, sources: [], tier: "strong" });
  assert.ok(out.text.startsWith(DISCLAIMER.strong));
  assert.ok(!out.text.includes(DISCLAIMER.short), "one disclaimer only");
  assert.match(DISCLAIMER.strong, /immigration-citizenship-representative\/choose\.html/);
});
