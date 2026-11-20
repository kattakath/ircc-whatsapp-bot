// FIX-23: media without text (S10, S48).
process.env.OPENAI_API_KEY = "test-not-a-key";
const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { mediaReply } = await import("../src/media.js");
const { pendingPromptText } = await import("../src/graph.js");

const AGE = "How old are you? (just the number)";

test("S10: a captionless photo mid-intake restates the pending question", () => {
  assert.equal(mediaReply({ mediaType: "image", pendingPrompt: AGE }), `I can't open photos or files yet. ${AGE}`);
});

test("S48: a voice note gets its own line; a repeat is shorter; a sticker gets no reply", () => {
  assert.equal(mediaReply({ mediaType: "audio", pendingPrompt: AGE }), `I can't listen to voice notes yet — could you type it? ${AGE}`);
  assert.equal(mediaReply({ mediaType: "audio", pendingPrompt: AGE, repeat: true }), `Please type it instead. ${AGE}`);
  assert.equal(mediaReply({ mediaType: "sticker", pendingPrompt: AGE }), null);
});

test("a document with no question pending: type the part you need, no ID numbers, high-stakes hint", () => {
  const r = mediaReply({ mediaType: "document" });
  assert.match(r, /type the part you have a question about/);
  assert.match(r, /without any ID numbers/);
  assert.match(r, /refusal, a deadline or a hearing/);
});

test("pendingPromptText: the slot prompt mid-intake, nothing otherwise", () => {
  assert.equal(pendingPromptText({ branch: "4", slotIndex: 0 }), AGE);
  assert.equal(pendingPromptText({ branch: null }), null);
  assert.equal(pendingPromptText({}), null);
});
