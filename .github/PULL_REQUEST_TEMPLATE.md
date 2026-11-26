## What & why

## Checklist
- [ ] `nix flake check -L` passes (module eval + package build)
- [ ] `.nix` formatted (`nixfmt-rfc-style`)
- [ ] No secrets committed; `auth/`/`.env` untouched
- [ ] Graph nodes stay side-effect-free before their `interrupt()` call
- [ ] `TOPIC_BRANCHES`/`BRANCH_SOURCES` still match `scripts/crawl-pages.js`'s `TOPIC_MAP` (if crawl scope changed)
- [ ] New env vars documented in `.env.example` and `nix/module.nix`
