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
#   - Darwin only: the login Keychain, read directly with
#     `/usr/bin/security find-generic-password`, for whatever `environmentFile`
#     (if set) left empty. `keychainServices` renames items and can carry the
#     per-operator ALLOWED_NUMBERS / CF_ACCOUNT_ID too, so a public consuming
#     flake holds no personal data at all.
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

  # env var -> Keychain service. The secrets are always looked up, under their own
  # names unless `keychainServices` maps them elsewhere. OPENAI_API_KEY is skipped
  # when `openaiBaseUrl` points elsewhere (a local Ollama needs no key, and the real
  # key should not travel to it), unless `keychainServices` maps it explicitly.
  keychainMap =
    lib.genAttrs (
      [
        "SERPER_API_KEY"
        "LANGCHAIN_API_KEY"
      ]
      ++ lib.optional (cfg.openaiBaseUrl == null) "OPENAI_API_KEY"
    ) lib.id
    // cfg.keychainServices;

  fromKeychain = name: pkgs.stdenv.hostPlatform.isDarwin && cfg.keychainServices ? ${name};

  secretsPrelude =
    lib.optionalString (cfg.environmentFile != null) ''
      set -a
      . ${lib.escapeShellArg cfg.environmentFile}
      set +a
    ''
    # Darwin: the Keychain fills whatever the environmentFile (if any) left
    # empty. A miss stays non-fatal (`|| true` under the runner's `set -eu`): the
    # key stays empty, and the required-key checks below are what fail. Values
    # only ever move variable-to-variable: never echoed, never argv.
    + lib.optionalString pkgs.stdenv.hostPlatform.isDarwin (
      lib.concatStrings (
        lib.mapAttrsToList (env: service: ''
          if [ -z "''${${env}:-}" ]; then
            ${env}="$(/usr/bin/security find-generic-password -a "$(id -un)" -s ${lib.escapeShellArg service} -w 2>/dev/null || true)"
            export ${env}
          fi
        '') keychainMap
      )
    );

  runner = pkgs.writeShellScriptBin "ircc-whatsapp-bot-run" ''
    set -eu
    ${secretsPrelude}
    ${lib.optionalString (cfg.openaiBaseUrl != null) ''
      # The OpenAI SDK reads OPENAI_BASE_URL itself; it still refuses an empty key,
      # which a local server ignores.
      export OPENAI_BASE_URL=${lib.escapeShellArg cfg.openaiBaseUrl}
      : "''${OPENAI_API_KEY:=not-needed}"
      export OPENAI_API_KEY
    ''}
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
    ${lib.optionalString (cfg.langsmithTracing && !cfg.langsmithShowContent) ''
      # FIX-07: traces keep timing and errors, never the conversation (langsmith SDK reads these).
      export LANGSMITH_HIDE_INPUTS=true
      export LANGSMITH_HIDE_OUTPUTS=true
    ''}
    ${lib.optionalString (cfg.allowedNumbers != [ ]) ''
      export ALLOWED_NUMBERS=${lib.escapeShellArg (lib.concatStringsSep "," cfg.allowedNumbers)}
    ''}
    # Empty ALLOWED_NUMBERS makes the bot answer ANYONE, so a service never starts without it.
    if [ -z "''${ALLOWED_NUMBERS:-}" ]; then
      echo "ircc-whatsapp-bot: missing ALLOWED_NUMBERS -- set services.irccWhatsappBot.allowedNumbers, ALLOWED_NUMBERS in environmentFile, or on Darwin keychainServices.ALLOWED_NUMBERS" >&2
      exit 1
    fi
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
      description = "Model for synthesis (overrides src/llm.js's own default via OPENAI_MODEL). With `openaiBaseUrl`, a model that endpoint serves, e.g. an Ollama tag.";
    };

    openaiBaseUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://127.0.0.1:11434/v1";
      description = ''
        Any endpoint that speaks the OpenAI Responses API (exported as
        OPENAI_BASE_URL, which the OpenAI SDK reads itself), e.g. a local Ollama.
        Null means api.openai.com. When set, OPENAI_API_KEY is no longer looked
        up in the Keychain or required; map `keychainServices.OPENAI_API_KEY`
        for an endpoint that does need a key.
      '';
    };

    langsmithTracing = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable LangSmith tracing (LANGCHAIN_TRACING_V2).";
    };

    langsmithShowContent = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Send message text and answers to LangSmith with each trace. Off by default
        (LANGSMITH_HIDE_INPUTS/OUTPUTS): users' immigration details stay on this machine and
        traces keep only timing, structure and errors (docs/conversation-design.md FIX-07).
      '';
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

    ragdbUri = lib.mkOption {
      type = lib.types.str;
      example = "postgresql://bot@127.0.0.1:5432/ircc";
      description = ''
        Postgres connection string for the LangGraph checkpointer
        (PostgresSaver creates its own tables). Retrieval does not use it --
        that is Cloudflare AI Search. Required: this flake bundles no Postgres,
        so the host points it at one it already runs.
      '';
    };

    keychainServices = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        SERPER_API_KEY = "serper.dev:api";
        ALLOWED_NUMBERS = "ircc:whatsapp:allowed-numbers";
        CF_ACCOUNT_ID = "cf:cloudflare.com:account-id";
      };
      description = ''
        Darwin only: env var -> login-Keychain service name, read at launch.
        OPENAI_API_KEY, SERPER_API_KEY and LANGCHAIN_API_KEY are always looked
        up, under their own names unless mapped here. Add ALLOWED_NUMBERS and
        CF_ACCOUNT_ID to keep those per-operator values out of Nix as well. A
        value environmentFile already set wins over the Keychain.
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
        assertion =
          cfg.allowedNumbers != [ ] || cfg.environmentFile != null || fromKeychain "ALLOWED_NUMBERS";
        message = "services.irccWhatsappBot.allowedNumbers is empty and neither environmentFile nor keychainServices.ALLOWED_NUMBERS can provide it -- the bot would answer every sender.";
      }
      {
        assertion =
          cfg.aiSearch.accountId != null || cfg.environmentFile != null || fromKeychain "CF_ACCOUNT_ID";
        message = "services.irccWhatsappBot.aiSearch.accountId is unset and there is no environmentFile to provide CF_ACCOUNT_ID -- retrieval needs the Cloudflare account id.";
      }
      {
        assertion = cfg.environmentFile != null || pkgs.stdenv.hostPlatform.isDarwin;
        message = "services.irccWhatsappBot.environmentFile must be set on non-Darwin systems -- there is no Keychain fallback there.";
      }
    ];

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
