# Configuration

Each setting has one home. This page points at them rather than copying them.

| What | Where it is defined |
| --- | --- |
| Environment variables: name, required or optional, default, purpose | [`.env.example`](../../.env.example) |
| Nix service options: `services.irccWhatsappBot.*` | [`nix/module.nix`](../../nix/module.nix) |
| Default synthesis model | `MODEL` in [`src/llm.js`](../../src/llm.js) |
| Default AI Search instance | `src/aisearch.js` (`CF_AI_SEARCH_INSTANCE`) |
| Retrieval thresholds | `SIMILARITY_FLOOR` in `src/db.js`, `GRADE_THRESHOLD` in `src/graph.js` |

A new environment variable goes in `.env.example` **and** `nix/module.nix` in the same change.

## Secrets

`OPENAI_API_KEY`, `SERPER_API_KEY`, `LANGCHAIN_API_KEY` and `CLOUDFLARE_AI_SEARCH_TOKEN` are
never read from Nix.

- **Run by hand:** put them in `.env`.
- **As a service:** set `environmentFile` to a `KEY=value` file outside Nix. It is required on
  Linux.
- **On macOS:** the login Keychain fills whatever is left empty. `src/aisearch.js` reads the AI
  Search token from the generic-password item `cf:cloudflare.com:ai-search` (account: your
  login user). `secret set cf:cloudflare.com:ai-search` creates it. That holds for the bot and
  for the re-crawl and ingest scripts alike, and the token is never logged.
- **`keychainServices`** maps an environment variable to a different Keychain item. It can also
  supply `ALLOWED_NUMBERS` and `CF_ACCOUNT_ID`, so a public consuming flake carries no personal
  data:

```nix
services.irccWhatsappBot.keychainServices = {
  SERPER_API_KEY = "serper.dev:api";
  ALLOWED_NUMBERS = "ircc:whatsapp:allowed-numbers"; # comma-separated digits
  CF_ACCOUNT_ID = "cf:cloudflare.com:account-id";
};
```

`CF_ACCOUNT_ID` is not a secret, but it is per-operator, so it never lives in this repo.

## Synthesis endpoint

`openaiBaseUrl` points synthesis at any OpenAI-Responses-compatible endpoint instead of
api.openai.com. A local Ollama works as-is, and then no OpenAI key is looked up:

```nix
services.irccWhatsappBot = {
  openaiBaseUrl = "http://127.0.0.1:11434/v1";
  model = "qwen3-vl:4b-instruct";
};
```

## Tracing

LangSmith tracing (`LANGCHAIN_TRACING_V2`, `LANGCHAIN_API_KEY`, `LANGCHAIN_PROJECT`) is off
unless `LANGCHAIN_TRACING_V2` is `true`. Under Nix, traces hide message text unless
`langsmithShowContent` is set.
