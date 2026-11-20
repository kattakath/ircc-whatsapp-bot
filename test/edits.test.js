// FIX-14: edits and deletes (S24, S25).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEditTracker, editedText, isMeaningfulEdit, isRevoke } from "../src/edits.js";

test("typo-only edits are not meaningful; a change of meaning, a number or a negation is", () => {
  assert.equal(isMeaningfulEdit("How long can I stay as a visiter", "How long can I stay as a visitor"), false);
  assert.equal(isMeaningfulEdit("What is the study permit fee", "What is the study permit fee?"), false);
  assert.equal(isMeaningfulEdit("what is the stdy permit fee", "What is the study permit fee"), false);
  assert.equal(isMeaningfulEdit("How long can I stay as a visiter", "How long can I stay as a visitor on a super visa?"), true);
  assert.equal(isMeaningfulEdit("How much is the study permit fee?", "How much is the work permit fee?"), true);
  assert.equal(isMeaningfulEdit("What is the study permit fee?", "What is the study permit fee for my son?"), true);
  assert.equal(isMeaningfulEdit("Can I apply in 2024?", "Can I apply in 2025?"), true);
  assert.equal(isMeaningfulEdit("Can my wife work in Canada?", "Can my wife not work in Canada?"), true);
});

test("S24: an edit of a queued message replaces its text before it is answered", () => {
  const t = createEditTracker();
  assert.equal(t.onEdit("m2", "What is the study permit fee for my son?"), "pending");
  assert.equal(t.begin("m2", "What is the study permit fee?"), "What is the study permit fee for my son?");
  assert.equal(t.finish("m2", "What is the study permit fee for my son?"), null, "the edit was used; nothing left to re-answer");
});

test("S24: an answered message: typo edit → nothing; meaning edit → re-answer once", () => {
  const t = createEditTracker();
  assert.equal(t.begin("m1", "How long can I stay as a visiter"), "How long can I stay as a visiter");
  assert.equal(t.finish("m1", "How long can I stay as a visiter"), null);
  assert.equal(t.onEdit("m1", "How long can I stay as a visitor"), "typo");
  assert.equal(t.onEdit("m1", "How long can I stay as a visitor on a super visa?"), "reanswer");
});

test("an edit that lands while the answer is in flight is re-answered after it, if it changed the meaning", () => {
  const t = createEditTracker();
  t.begin("m1", "Can my wife work in Canada?");
  assert.equal(t.onEdit("m1", "Can my wife study in Canada?"), "pending");
  assert.equal(t.finish("m1", "Can my wife work in Canada?"), "Can my wife study in Canada?");
  const u = createEditTracker();
  u.begin("m1", "Can my wife work in Canada?");
  u.onEdit("m1", "Can my wife work in Canada");
  assert.equal(u.finish("m1", "Can my wife work in Canada?"), null, "typo-only in-flight edit");
});

test("S25: a deleted message that is still queued is never answered", () => {
  const t = createEditTracker();
  t.onRevoke("m2");
  assert.equal(t.isRevoked("m2"), true);
  assert.equal(t.isRevoked("m1"), false);
});

test("Baileys update shapes: edit text and revoke", () => {
  const edit = { message: { editedMessage: { message: { conversation: "new text" } } } };
  const editExt = { message: { editedMessage: { message: { extendedTextMessage: { text: "new ext" } } } } };
  assert.equal(editedText(edit), "new text");
  assert.equal(editedText(editExt), "new ext");
  assert.equal(editedText({ status: 3 }), null, "a receipt is not an edit");
  assert.equal(isRevoke({ message: null, messageStubType: 1 }), true);
  assert.equal(isRevoke({ status: 4 }), false);
  assert.equal(isRevoke(edit), false);
});

test("the tracker is bounded", () => {
  const t = createEditTracker({ limit: 3 });
  for (let i = 0; i < 10; i++) { t.begin(`m${i}`, "q"); t.finish(`m${i}`, "q"); }
  assert.equal(t.onEdit("m0", "a totally different question about work permits"), "pending", "m0 was evicted: unknown, not re-answered");
  assert.equal(t.size() <= 3 * 3, true);
});

test("short words get no typo tolerance: PR→PN and TRV→TRP change the meaning", () => {
  assert.equal(isMeaningfulEdit("Can I apply for PR?", "Can I apply for PN?"), true);
  assert.equal(isMeaningfulEdit("How long is a TRV valid", "How long is a TRP valid"), true);
  assert.equal(isMeaningfulEdit("What is the fee", "What are the fees"), false, "fee→fees is still a typo");
});

test("a message answered by a fixed reply (ID number, scam, 'answered above') is settled, so a later edit is re-answered", () => {
  const t = createEditTracker();
  t.begin("m1", "my UCI is 1234-5678, status?");
  assert.equal(t.finish("m1", ""), null, "settled with no text kept");
  assert.equal(t.onEdit("m1", "How do I check my application status?"), "reanswer");
});
