// FIX-34: heuristic split of compound questions (S43). Judgement-call rules; the negatives matter
// as much as the positives — a wrong split answers a question nobody asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCompound } from "../src/compound.js";

test("S43: three questions joined by 'and' split into three parts", () => {
  const { parts, rest } = splitCompound("how much study permit fee and can my wife work and kids school free?");
  assert.deepEqual(parts, ["how much study permit fee", "can my wife work", "kids school free"]);
  assert.deepEqual(rest, []);
});

test("S43: an acronym list keeps 3 parts and names the rest", () => {
  const { parts, rest } = splitCompound("what is PGWP and SOWP and IEC and LMIA?");
  assert.deepEqual(parts, ["what is PGWP", "what is SOWP", "what is IEC"]);
  assert.deepEqual(rest, ["LMIA"]);
});

test("two '?' questions split; 'and' before a question word splits", () => {
  assert.deepEqual(splitCompound("How do I apply? How long does it take?").parts, ["How do I apply", "How long does it take"]);
  assert.deepEqual(splitCompound("How do I apply for a study permit and how long does it take?").parts, ["How do I apply for a study permit", "how long does it take"]);
});

test("single questions are NOT split", () => {
  for (const q of [
    "Can my wife and kids come with me?",
    "What is the fee for me and my wife?",
    "Do I need a visa and a work permit?",
    "How long is a visitor visa valid?",
    "Can I study and work at the same time?",
    "what are the requirements for spousal sponsorship and how much",
  ]) assert.equal(splitCompound(q).parts.length, 1, q);
});
