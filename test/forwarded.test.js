// FIX-39: forwarded messages (S51).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAUD_CHECK, scamAction as forwardedAction, isScamLike } from "../src/gate.js";

test("S51: forwarded scam-like text gets the fraud check; other forwards are answered with a preface", () => {
  const fwd = (text) => ({ kind: "text", text, forwarded: true });
  assert.equal(forwardedAction(fwd("IRCC: your PR is cancelled, pay $500 now to restore it. is this true?")), "fraud");
  assert.equal(forwardedAction(fwd("Express Entry draw results are out today")), "forwarded");
  assert.equal(forwardedAction({ kind: "text", text: "pay $500 now", forwarded: false }), null, "not forwarded");
});

test("scam signs: money + urgency, or a threat with urgency or money; plain questions are not", () => {
  for (const t of [
    "Your visa will be revoked unless you pay the penalty",
    "Send the fee by gift card within 24 hours",
    "Final notice: police will arrest you today",
  ]) assert.equal(isScamLike(t), true, t);
  for (const t of [
    "What is the fee for a study permit?",
    "How long does a work permit take?",
    "Express Entry draw results are out today",
  ]) assert.equal(isScamLike(t), false, t);
});

test("the fraud check never restates the claim and links IRCC's own pages", () => {
  assert.ok(!/\$500|cancelled|restore/i.test(FRAUD_CHECK));
  assert.match(FRAUD_CHECK, /never asks for any payment by phone/);
  assert.match(FRAUD_CHECK, /protect-fraud\/internet-email-telephone\.html/);
  assert.match(FRAUD_CHECK, /protect-fraud\/report-fraud\.html/);
});

// FIX-39b: a scam notice that is PASTED (or forwarded by its own author, which WhatsApp does not
// mark as forwarded) used to go to RAG, whose answer repeated the scam's "act within 24 hours".
import { fraudCheck, scamAction } from "../src/gate.js";

test("S51b: a pasted scam notice gets the fraud check too", () => {
  const typed = (text) => ({ kind: "text", text, forwarded: false });
  for (const t of [
    "IRCC notice: your study permit is cancelled. Pay the $500 penalty within 24 hours by gift card or you will be deported.",
    "Your PR card has been suspended. Pay $300 immediately to avoid arrest. Is this real?",
    "I got this: send the fine by bitcoin today or police will come",
  ]) assert.equal(scamAction(typed(t)), "fraud", t);
});

test("S51b: a person's own question about fees, deadlines or deportation is not a scam notice", () => {
  const typed = (text) => ({ kind: "text", text, forwarded: false });
  for (const t of [
    "Will my visa be cancelled if I don't pay the fee today?",
    "Is it true IRCC can deport me if I don't pay within 24 hours?",
    "How much is the study permit fee?",
    "My study permit expired, do I have to pay a fine to restore it?",
    "Can I be deported for working more than 24 hours a week?",
  ]) assert.equal(scamAction(typed(t)), null, t);
});

test("S51b: forwards keep their routes; the pasted reply does not call it forwarded", () => {
  const fwd = (text) => ({ kind: "text", text, forwarded: true });
  assert.equal(scamAction(fwd("Pay the $500 fine now or your visa will be revoked")), "fraud");
  assert.equal(scamAction(fwd("Express Entry draw results are out today")), "forwarded");
  assert.match(fraudCheck({ forwarded: true }), /^⚠️ This forwarded message has signs of a scam/);
  assert.match(fraudCheck({ forwarded: false }), /^⚠️ This message has signs of a scam/);
  assert.ok(!/forwarded/.test(fraudCheck({ forwarded: false })));
});
