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
#   - Darwin only, when `environmentFile` is unset: the login Keychain, via
#     `security find-generic-password` — same pattern as the
#     telegramMcp/wpMcp/apifyMcp wrappers in nix-config's modules/shared/mcp.nix.
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
        OPENAI_API_KEY="$(/usr/bin/security find-generic-password -a "$(id -un)" -s OPENAI_API_KEY -w 2>/dev/null || true)"
        SERPER_API_KEY="$(/usr/bin/security find-generic-password -a "$(id -un)" -s SERPER_API_KEY -w 2>/dev/null || true)"
        LANGCHAIN_API_KEY="$(/usr/bin/security find-generic-password -a "$(id -un)" -s LANGCHAIN_API_KEY -w 2>/dev/null || true)"
        export OPENAI_API_KEY SERPER_API_KEY LANGCHAIN_API_KEY
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

    localRag = {
      enable = lib.mkEnableOption ''
        provisioning a local RAG Postgres (pgvector + Ollama embed()) via
        nix-local-rag (github:kattakath/nix-local-rag), instead of
        bringing your own via `ragdbUri`. Same "createLocally" idiom as
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
        pgvector Postgres connection string. Needs a `docs` table
        (content/metadata/embedding) and an `embed(text)` SQL function --
        see the repo README's RAG section. Defaults to nix-local-rag's own
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
        OPENAI_API_KEY / SERPER_API_KEY / LANGCHAIN_API_KEY. Required on
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
