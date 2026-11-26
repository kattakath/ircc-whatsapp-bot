{
  description = "WhatsApp bot answering Canadian immigration questions, grounded in official IRCC content via a Cloudflare AI Search RAG store";

  inputs = {
    # The fleet's shared repo shape (kattakath/nix-config ADR-016): devShell from one
    # package list, treefmt, and the generated LICENSE/.envrc/.editorconfig/devcontainer
    # with drift checks. It brings treefmt-nix itself, so this flake no longer imports one.
    repo-kit.url = "github:ismailkattakath/repo-kit";
    nixpkgs.follows = "repo-kit/nixpkgs";
    flake-parts.follows = "repo-kit/flake-parts";
  };

  outputs =
    inputs@{
      flake-parts,
      repo-kit,
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
        #         ragdbUri = "postgresql://..."; # your Postgres, for the checkpoints
        #       }; }
        #   ];
        # The flake bundles no Postgres: the host brings its own (nixpkgs'
        # services.postgresql, or any other) and points `ragdbUri` at it.
        # `botOnly` is the same module under its older name, kept because
        # kattakath/nix-config imports it by that name.
        homeManagerModules = {
          default = ./nix/module.nix;
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
