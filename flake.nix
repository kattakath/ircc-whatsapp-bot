{
  description = "WhatsApp bot answering Canadian immigration questions, grounded in official IRCC content via a Cloudflare AI Search RAG store";

  inputs = {
    # The fleet's shared repo shape (kattakath/nix-config ADR-016): devShell from one
    # package list, treefmt, and the generated LICENSE/.envrc/.editorconfig/devcontainer
    # with drift checks. It brings treefmt-nix itself, so this flake no longer imports one.
    repo-kit.url = "github:ismailkattakath/repo-kit";
    nixpkgs.follows = "repo-kit/nixpkgs";
    flake-parts.follows = "repo-kit/flake-parts";

    # Optional local Postgres provider (nix-local-rag's pgvector + Ollama) --
    # see nix/module.nix's `localRag.enable`. Retrieval moved to Cloudflare AI
    # Search (2026-11-19); the bot now uses this Postgres only for its
    # LangGraph checkpoints. Always
    # fetched (a flake input can't be conditional), but its module does
    # nothing unless that option turns it on, same "always import, gate by
    # .enable" idiom nixpkgs itself uses for `services.postgresql`.
    nix-local-rag.url = "github:kattakath/nix-local-rag";
    nix-local-rag.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    inputs@{
      flake-parts,
      repo-kit,
      nix-local-rag,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        repo-kit.flakeModules.default
        # `nix flake check`'s own gates: formatting, project-gate (toolchain-complete
        # and the generated-file drift checks come from repo-kit). Its own module so
        # this file stays inputs + composition.
        ./nix/checks.nix
      ];

      # x86_64-darwin deliberately excluded: nixpkgs-unstable (26.11) dropped
      # it entirely (Intel Mac sunset) -- pinning to an older nixpkgs just for
      # that one system isn't worth the added complexity here. The other
      # three cover every platform actually in scope today.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      repoKit = {
        name = "ircc-whatsapp-bot";
        license = {
          spdx = "MIT";
          year = "2026";
          holder = "Ismail Kattakath";
        };
      };

      flake = {
        # `services.irccWhatsappBot` — see nix/module.nix. Consumers:
        #   inputs.ircc-whatsapp-bot.url = "github:kattakath/ircc-whatsapp-bot";
        #   inputs.ircc-whatsapp-bot.inputs.nixpkgs.follows = "nixpkgs";
        #   extraHomeModules = [
        #     ircc-whatsapp-bot.homeManagerModules.default
        #     { services.irccWhatsappBot = {
        #         enable = true;
        #         allowedNumbers = [ "1..." ];
        #         localRag.enable = true; # no Postgres of your own? this provisions one.
        #       }; }
        #   ];
        # TWO module outputs, because "who provides pgvectorLocal" is the
        # consumer's decision, not this flake's.
        #
        # `default` is batteries-included and UNCHANGED: it imports
        # nix-local-rag's module so `localRag.enable` has something to flip and
        # `ragdbUri` has `services.pgvectorLocal.databaseUri` to default from.
        # That is the right shape for a host that has no pgvector of its own.
        #
        # `botOnly` is the same bot module WITHOUT that import, for a host that
        # ALREADY declares `services.pgvectorLocal` — because two different
        # fetches of nix-local-rag are two different store paths, and the module
        # system hard-errors with "option declared multiple times" when both are
        # imported into one config. Today a consumer can dodge that with a
        # `follows` chain, but a `follows` needs a flake input to point AT: a
        # host that vendors the module in-tree (no input at all) has nothing to
        # chain to, and `botOnly` is the only way out. Opting out of an import is
        # not expressible in `imports` itself, which is why this is a second
        # output rather than an option.
        homeManagerModules = {
          default =
            { config, lib, ... }:
            let
              cfg = config.services.irccWhatsappBot;
            in
            {
              imports = [
                ./nix/module.nix
                nix-local-rag.homeManagerModules.default
              ];
              # Here, not in module.nix: only this output declares these options.
              config = lib.mkIf (cfg.enable && cfg.localRag.enable) {
                services.pgvectorLocal.enable = lib.mkDefault true;
                services.ollamaLocal.enable = lib.mkDefault true;
              };
            };
          botOnly = ./nix/module.nix;
        };
      };

      perSystem =
        { pkgs, ... }:
        let
          # The dev toolchain, read from ONE place (nix/toolchain.nix). repo-kit builds
          # `devShells.default` from `devPackages` and its `checks.toolchain-complete`
          # asserts every `requiredBins` name resolves from that same list — so edit the
          # list THERE, never inline here.
          toolchain = import ./nix/toolchain.nix { inherit pkgs; };
        in
        {
          packages.default = pkgs.callPackage ./nix/package.nix { };

          repoKit = {
            devPackages = toolchain.packages;
            inherit (toolchain) requiredBins;
            shellHook = ''
              echo "ircc-whatsapp-bot dev shell — npm install && npm start (see .env.example for required env vars)"
            '';
          };

          # treefmt owns `nix fmt` and supplies its own `checks.treefmt` gate, so CI
          # needs no hand-rolled formatting step: `nix flake check` runs the formatter
          # from THIS flake's lock instead of the runner's ambient registry. Same tool
          # set as every other fleet flake — a bare `formatter = pkgs.nixfmt-rfc-style`
          # (what this was) formats but never LINTS, so statix anti-patterns and
          # deadnix's unused bindings went uncaught here while siblings caught them.
          treefmt = {
            programs.deadnix.enable = true;
            programs.statix.enable = true;
          };
        };
    };
}
