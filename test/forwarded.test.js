// FIX-39: forwarded messages (S51).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAUD_CHECK, forwardedAction, isScamLike } from "../src/gate.js";

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
