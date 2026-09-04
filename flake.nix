{
  description = "WhatsApp bot answering Canadian immigration questions, grounded in official IRCC content via a local pgvector RAG store";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

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
      self,
      flake-parts,
      nix-local-rag,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } {
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
        # nix-local-rag's module is always imported (see the input comment above)
        # so `localRag.enable` has something to flip and `ragdbUri` has
        # `services.pgvectorLocal.databaseUri` to default from either way.
        homeManagerModules.default = {
          imports = [
            ./nix/module.nix
            nix-local-rag.homeManagerModules.default
          ];
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

          formatter = pkgs.nixfmt-rfc-style;
        };
    };
}
