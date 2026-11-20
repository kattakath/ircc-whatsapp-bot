// FIX-07: identifier recognisers (S12). Positives must be caught; ordinary immigration talk
// (phone numbers, years, day counts, scores, fees) must not be.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSensitive, sensitiveReply, STATUS_URL } from "../src/redact.js";

test("S12: identifiers are recognised", () => {
  assert.deepEqual(findSensitive("my UCI is 12-3456-7890 what is my status"), ["UCI"]);
  assert.deepEqual(findSensitive("uci 1234-5678 pls check"), ["UCI"]);
  assert.deepEqual(findSensitive("SIN 123-456-789"), ["SIN"]);
  assert.deepEqual(findSensitive("application E001234567 is stuck"), ["application number"]);
  assert.deepEqual(findSensitive("my passport number is AB123456"), ["passport number"]);
});

test("ordinary immigration talk is not flagged", () => {
  for (const t of [
    "call me at 514-555-1234",
    "I lived here 2019 2020 and 2021",
    "do I need 1095 days?",
    "my CRS score is 480",
    "the fee is $1,365",
    "I have 3 kids aged 4, 7 and 12",
    "What is a study permit?",
    "is IMM 5644 the right form",
  ]) assert.deepEqual(findSensitive(t), [], t);
});

test("the reply names the kind, points to the official status tools, and asks to delete", () => {
  const r = sensitiveReply(["UCI"]);
  assert.match(r, /UCI/);
  assert.ok(r.includes(STATUS_URL));
  assert.match(r, /delete/i);
  assert.ok(!/\d{4}-\d{4}/.test(r), "the reply never echoes a number");
});
