// Dev utility: simulate a WhatsApp conversation against the LangGraph-based
// dialogue engine, including a real "process restart" mid-conversation
// (a fresh compiled graph instance, same checkpointer/thread_id) to verify
// crash-safety. Usage:
//   node src/simulate.js "msg one" "msg two" ...
// A message literally equal to "__RESTART__" simulates a process crash by
// compiling a brand-new graph instance before continuing.
import "dotenv/config";
import { Command } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { builder } from "./graph.js";
import { closeDb } from "./db.js";

const threadId = "sim-thread-" + Date.now();
const config = { configurable: { thread_id: threadId } };
// Same RAGDB_URI-with-fallback shape as db.js and index.js — this was the one
// entry point that hardcoded the URI, so simulating against a non-default
// database silently checkpointed to the default one instead.
const checkpointer = PostgresSaver.fromConnString(
  process.env.RAGDB_URI ?? "postgresql://mcp@127.0.0.1:5433/ragdb",
);
await checkpointer.setup();

let graph = builder.compile({ checkpointer });
const messages = process.argv.slice(2);

for (const msg of messages) {
  if (msg === "__RESTART__") {
    console.log("\n>>> [simulated process restart — fresh graph instance] <<<");
    graph = builder.compile({ checkpointer });
    continue;
  }

  console.log(`\n>>> ${msg}`);
  const isFresh = (await graph.getState(config)).next.length === 0;
  const input = isFresh ? { incomingText: msg } : new Command({ resume: msg });
  const result = await graph.invoke(input, config);
  const reply = result.__interrupt__?.[0]?.value ?? "(no interrupt — graph ended?)";
  console.log(`<<< ${reply}`);
}

await checkpointer.end?.();
await closeDb();
