# Run it as a Nix service

Run by hand, the bot is a foreground Node process: `npm start` and leave the terminal open. For
anything permanent, the flake's Home Manager module supervises it instead, restarting it after
a crash or a reboot. It runs under `launchd` on Darwin and `systemd --user` on Linux. The Linux
path is real but untested: no Linux host runs it today.

The flake's `systems` list in [`flake.nix`](../../flake.nix) says which platforms it builds for.

## Add it to a consuming flake

```nix
{
  inputs.ircc-whatsapp-bot.url = "github:kattakath/ircc-whatsapp-bot";
  inputs.ircc-whatsapp-bot.inputs.nixpkgs.follows = "nixpkgs";
  # ... in your home-manager modules:
  #   ircc-whatsapp-bot.homeManagerModules.default
  #   { services.irccWhatsappBot = {
  #       enable = true;
  #       allowedNumbers = [ "15145551234" ]; # real numbers -- keep these out of a public flake
  #       ragdbUri = "postgresql://bot@127.0.0.1:5432/ircc"; # your Postgres, see below
  #     }; }
}
```

The full option surface is [`nix/module.nix`](../../nix/module.nix). Secrets and the Keychain
mapping are in [configuration](../reference/configuration.md#secrets).

**The service refuses to start with an empty `ALLOWED_NUMBERS`.** Unset, the bot would answer
anyone.

## Postgres: checkpoints only

The bot needs a reachable Postgres for its LangGraph checkpoints. Retrieval does not touch it:
that is Cloudflare AI Search. A database is third-party infrastructure, so this flake does not
bundle one: bundling would give a host that runs anything *else* on Postgres two redundant,
possibly conflicting instances.

- **`ragdbUri` is required.** Point it at a Postgres the host already runs, for example
  nixpkgs' own `services.postgresql`.
- **No Postgres yet?** Turn on `services.postgresql` (NixOS and nix-darwin both have it), create
  a database and role for the bot, and pass its URI.
- **`botOnly`** is the same module as `default`, under its older name. Existing consumers keep
  working.

## Never run two copies against one paired session

Do not run the built binary (or `nix build`'s `result/`) from a directory that holds a *live,
paired* `auth/` session while that session's real bot process is also running. WhatsApp treats
it as a second device on the same credentials and forces both connections to re-pair. The
service avoids this by running from its own `stateDir` (default
`~/.local/state/ircc-whatsapp-bot`), apart from any checkout's `auth/`.
