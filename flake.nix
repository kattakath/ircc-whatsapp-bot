{
  description = "WhatsApp bot answering Canadian immigration questions, grounded in official IRCC content via a local pgvector RAG store";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";

    # Optional local-RAG dependency (pgvector + Ollama, exposing an in-DB
    # embed() SQL function) -- see nix/module.nix's `localRag.enable`. Always
    # fetched (a flake input can't be conditional), but its module does
    # nothing unless that option turns it on, same "always import, gate by
    # .enable" idiom nixpkgs itself uses for `services.postgresql`.
    nix-local-rag.url = "github:kattakath/nix-local-rag";
    nix-local-rag.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    inputs@{
      flake-parts,
      nix-local-rag,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ inputs.treefmt-nix.flakeModule ];

      # x86_64-darwin deliberately excluded: nixpkgs-unstable (26.11) dropped
      # it entirely (Intel Mac sunset) -- pinning to an older nixpkgs just for
      # that one system isn't worth the added complexity here. The other
      # three cover every platform actually in scope today.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

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
          default = {
            imports = [
              ./nix/module.nix
              nix-local-rag.homeManagerModules.default
            ];
          };
          botOnly = ./nix/module.nix;
        };
      };

      perSystem =
        { pkgs, ... }:
        {
          packages.default = pkgs.callPackage ./nix/package.nix { };

          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.nodejs
              pkgs.postgresql
            ];
            shellHook = ''
              echo "ircc-whatsapp-bot dev shell — npm install && npm start (see README for required env vars)"
            '';
          };

          # treefmt owns `nix fmt` and supplies its own `checks.treefmt` gate, so CI
          # needs no hand-rolled formatting step: `nix flake check` runs the formatter
          # from THIS flake's lock instead of the runner's ambient registry. Same tool
          # set as every other fleet flake — a bare `formatter = pkgs.nixfmt-rfc-style`
          # (what this was) formats but never LINTS, so statix anti-patterns and
          # deadnix's unused bindings went uncaught here while siblings caught them.
          treefmt = {
            projectRootFile = "flake.nix";
            programs.nixfmt.enable = true;
            programs.deadnix.enable = true;
            programs.statix.enable = true;
          };
        };
    };
}
