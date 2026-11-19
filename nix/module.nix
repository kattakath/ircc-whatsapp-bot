# home-manager module: services.irccWhatsappBot
#
# Runs the bot (packaged via ../nix/package.nix) as a supervised background
# service — launchd on Darwin, systemd --user on Linux (real, but currently
# untested: no Linux host runs this today). Ships no personal data: real
# WhatsApp numbers are provided entirely by the consuming flake via
# `allowedNumbers`.
#
# Secrets (OPENAI_API_KEY / SERPER_API_KEY / LANGCHAIN_API_KEY) are never read
# from Nix. Two supported sources:
#   - `environmentFile`: a KEY=value file outside Nix (chmod 600), sourced at
#     launch. Works on any platform; REQUIRED on Linux.
#   - Darwin only, when `environmentFile` is unset: the login Keychain, read
#     directly with `/usr/bin/security find-generic-password`.
#
# The Cloudflare AI Search token (CLOUDFLARE_AI_SEARCH_TOKEN) follows the same
# two sources, but its Keychain lookup lives in src/aisearch.js, not in the
# runner below: its Keychain service (`cf:cloudflare.com:ai-search`) is not its
# env name, and the recrawl job and ingest scripts need the lookup too, without
# this runner. The account id is not a secret and comes from `aiSearch.accountId`
# (or the environmentFile).
#
# Why the raw `security` call rather than the fleet's own keychain-secrets flake
# (github:kattakath/nix-keychain-secrets)? DEPENDENCY DIRECTION: it is not an
# input here (see flake.nix), and a standalone public flake should not take a
# hard input on a personal secrets flake to gain nothing. Grepped
# keychain-secrets/modules for a read option — only
# `programs.keychainSecrets.{enable,loaderRelPath}` exists
# (modules/keychain-secrets.nix:156-158), no per-service read → custom. Its
# reusable `secret get` bottoms out in exactly the call below anyway
# (packages/secret.nix:35 sets `security=/usr/bin/security`; do_get at :75 runs
# `find-generic-password -a "$account" -s "$1" -w`). The reason is NOT that a
# launchd agent has no shell to source a loader in: `secret` is a plain
# writeShellApplication store binary (same file, :31) an agent could exec.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.irccWhatsappBot;

  secretsPrelude =
    if cfg.environmentFile != null then
      ''
        set -a
        . ${lib.escapeShellArg cfg.environmentFile}
        set +a
      ''
    else if pkgs.stdenv.hostPlatform.isDarwin then
      ''
        # A miss stays non-fatal (`|| true` under the runner's `set -eu`): the
        # key exports empty, and the required-key check below is what fails.
        # Values only ever move variable-to-variable — never echoed, never argv.
        for __key in OPENAI_API_KEY SERPER_API_KEY LANGCHAIN_API_KEY; do
          export "$__key=$(/usr/bin/security find-generic-password -a "$(id -un)" -s "$__key" -w 2>/dev/null || true)"
        done
        unset __key
      ''
    else
      "";

  runner = pkgs.writeShellScriptBin "ircc-whatsapp-bot-run" ''
    set -eu
    ${secretsPrelude}
    if [ -z "''${OPENAI_API_KEY:-}" ] || [ -z "''${SERPER_API_KEY:-}" ]; then
      echo "ircc-whatsapp-bot: missing OPENAI_API_KEY and/or SERPER_API_KEY -- set services.irccWhatsappBot.environmentFile, or on Darwin: secret set OPENAI_API_KEY <key> / secret set SERPER_API_KEY <key>" >&2
      exit 1
    fi
    ${lib.optionalString (cfg.aiSearch.accountId != null) ''
      export CF_ACCOUNT_ID=${lib.escapeShellArg cfg.aiSearch.accountId}
    ''}
    if [ -z "''${CF_ACCOUNT_ID:-}" ]; then
      echo "ircc-whatsapp-bot: missing CF_ACCOUNT_ID -- set services.irccWhatsappBot.aiSearch.accountId, or CF_ACCOUNT_ID in environmentFile" >&2
      exit 1
    fi
    ${lib.optionalString (!pkgs.stdenv.hostPlatform.isDarwin) ''
      if [ -z "''${CLOUDFLARE_AI_SEARCH_TOKEN:-}" ]; then
        echo "ircc-whatsapp-bot: missing CLOUDFLARE_AI_SEARCH_TOKEN -- set it in services.irccWhatsappBot.environmentFile (no Keychain fallback off Darwin)" >&2
        exit 1
      fi
    ''}
    export CF_AI_SEARCH_INSTANCE=${lib.escapeShellArg cfg.aiSearch.instance}
    export LANGCHAIN_TRACING_V2=${if cfg.langsmithTracing then "true" else "false"}
    export LANGCHAIN_PROJECT=${lib.escapeShellArg cfg.langsmithProject}
    export ALLOWED_NUMBERS=${lib.escapeShellArg (lib.concatStringsSep "," cfg.allowedNumbers)}
    export OPENAI_MODEL=${lib.escapeShellArg cfg.model}
    export RAGDB_URI=${lib.escapeShellArg cfg.ragdbUri}
    mkdir -p ${lib.escapeShellArg cfg.stateDir}
    cd ${lib.escapeShellArg cfg.stateDir}
    exec ${lib.getExe cfg.package}
  '';
in
{
  options.services.irccWhatsappBot = {
    enable = lib.mkEnableOption "the IRCC WhatsApp immigration-help bot as a supervised background service";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      description = "The ircc-whatsapp-bot package to run.";
    };

    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/.local/state/ircc-whatsapp-bot";
      description = ''
        Writable runtime directory the service runs from. Baileys' paired
        `auth/` session (created on first QR pairing) lives here, since the
        package itself resolves to an immutable Nix store path.
      '';
    };

    allowedNumbers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        WhatsApp numbers (bare digits, country code included, no "+")
        permitted to talk to the bot. Real numbers are personal data --
        set this only in a private consuming flake, never here.
      '';
    };

    model = lib.mkOption {
      type = lib.types.str;
      default = "gpt-5.5";
      description = "OpenAI model for synthesis (overrides src/llm.js's own default via OPENAI_MODEL).";
    };

    langsmithTracing = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable LangSmith tracing (LANGCHAIN_TRACING_V2).";
    };

    langsmithProject = lib.mkOption {
      type = lib.types.str;
      default = "ircc-whatsapp-bot";
      description = "LangSmith project name traces are grouped under.";
    };

    aiSearch = {
      accountId = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          Cloudflare account id holding the AI Search instance the bot
          retrieves from (exported as CF_ACCOUNT_ID). Not a secret, but
          per-operator: set it in the consuming flake. Null means the
          environmentFile must provide CF_ACCOUNT_ID instead. The API token is
          never a Nix value: CLOUDFLARE_AI_SEARCH_TOKEN in environmentFile, or
          on Darwin the login-Keychain item `cf:cloudflare.com:ai-search`.
        '';
      };

      instance = lib.mkOption {
        type = lib.types.str;
        default = "rag";
        description = "AI Search instance id (exported as CF_AI_SEARCH_INSTANCE).";
      };
    };

    localRag = {
      enable = lib.mkEnableOption ''
        provisioning a local Postgres via nix-local-rag
        (github:kattakath/nix-local-rag, pgvector + Ollama) for the bot's
        LangGraph checkpoints, instead of bringing your own via `ragdbUri`.
        Retrieval no longer uses it (Cloudflare AI Search since 2026-11-19).
        Same "createLocally" idiom as
        nixpkgs' own services.<app>.database.createLocally options -- off
        by default so a host that already provisions pgvectorLocal itself
        (e.g. because something else on the host also needs it) doesn't get
        a second, redundant instance
      '';
    };

    ragdbUri = lib.mkOption {
      type = lib.types.str;
      default = config.services.pgvectorLocal.databaseUri;
      description = ''
        Postgres connection string for the LangGraph checkpointer
        (PostgresSaver creates its own tables). Retrieval does not use it any
        more -- that is Cloudflare AI Search. Defaults to nix-local-rag's own
        `services.pgvectorLocal.databaseUri` (single-sourced, not
        duplicated here) whether or not `localRag.enable` actually turns
        that service on -- override this directly if you're pointing at
        Postgres running elsewhere instead.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Path to a KEY=value file (outside Nix, chmod 600) providing
        OPENAI_API_KEY / SERPER_API_KEY / LANGCHAIN_API_KEY, and the AI
        Search CLOUDFLARE_AI_SEARCH_TOKEN (plus CF_ACCOUNT_ID when
        `aiSearch.accountId` is null). Required on
        Linux (no Keychain fallback). On Darwin, leaving this null falls
        back to login-Keychain lookups.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.allowedNumbers != [ ];
        message = "services.irccWhatsappBot.allowedNumbers is empty -- the bot would refuse every sender.";
      }
      {
        assertion = cfg.aiSearch.accountId != null || cfg.environmentFile != null;
        message = "services.irccWhatsappBot.aiSearch.accountId is unset and there is no environmentFile to provide CF_ACCOUNT_ID -- retrieval needs the Cloudflare account id.";
      }
      {
        assertion = cfg.environmentFile != null || pkgs.stdenv.hostPlatform.isDarwin;
        message = "services.irccWhatsappBot.environmentFile must be set on non-Darwin systems -- there is no Keychain fallback there.";
      }
    ];

    services.pgvectorLocal.enable = lib.mkIf cfg.localRag.enable (lib.mkDefault true);
    services.ollamaLocal.enable = lib.mkIf cfg.localRag.enable (lib.mkDefault true);

    launchd.agents.ircc-whatsapp-bot = lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
      enable = true;
      config = {
        ProgramArguments = [ (lib.getExe runner) ];
        RunAtLoad = true;
        KeepAlive = true;
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/ircc-whatsapp-bot.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/ircc-whatsapp-bot.log";
      };
    };

    systemd.user.services.ircc-whatsapp-bot = lib.mkIf pkgs.stdenv.hostPlatform.isLinux {
      Unit.Description = "IRCC WhatsApp immigration-help bot";
      Service = {
        ExecStart = lib.getExe runner;
        Restart = "always";
      };
      Install.WantedBy = [ "default.target" ];
    };
  };
}
