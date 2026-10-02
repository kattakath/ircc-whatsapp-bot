# Contributing

A small, focused project — contributions that keep it that way are the most
welcome.

## Dev loop

```sh
npm install
node src/test-pipeline.js "How to come to Canada?"   # retrieval+synthesis only, no WhatsApp
node src/simulate.js "hi" "2" "1"                      # full dialogue graph, no WhatsApp

npm run lint                             # offline gate: every .js parses, every
                                         #   bare import resolves (no key, no DB)

nix flake check -L                       # formatting + toolchain-complete + project-gate
nix fmt                                  # nixfmt + deadnix + statix (CI enforces this)
nix build                                # real buildNpmPackage derivation
```

`nix flake check` runs `npm run lint` for you as `checks.project-gate`, against a
node_modules vendored from `package-lock.json` — so it needs no network, and a
lockfile bump is the only thing that can make it refetch.

## Guidelines

- **Graph nodes must stay side-effect-free before their `interrupt()` call**
  (`src/graph.js`) — LangGraph re-executes a node from the top on
  resume-after-crash, so any I/O (sending a message, etc.) placed before an
  `interrupt()` would double-fire. Only `src/index.js` sends WhatsApp
  messages, driven by the graph's output.
- If you widen the RAG crawl scope, keep `graph.js`'s `TOPIC_BRANCHES`/
  `BRANCH_SOURCES` in sync with `scripts/chunking.js`'s `TOPIC_MAP` — a
  mismatch makes a menu branch silently return zero results.
- Never run a built binary (or `nix build`'s `result/`) from a checkout that
  holds a *live, paired* `auth/` session while that session's real bot
  process is also running — see the README's caution; it force-repairs both.
- Keep the legal-boundary framing intact (`src/llm.js`'s system prompt +
  README's "Legal boundary" section) — this bot gives informal information,
  never presented as licensed immigration advice.
- New env vars: update `.env.example`, `nix/module.nix`'s option surface,
  and the README together — don't let them drift.
- Update `README.md` for user-facing changes; CI (format + `nix flake check`)
  must pass.
