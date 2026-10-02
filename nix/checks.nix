# `nix flake check`'s gates — a flake-parts module, imported by flake.nix.
#
# Three named checks, each able to go red for a DIFFERENT reason:
#
#   formatting          a tracked file is not formatted / lints dirty per the
#                       `treefmt` block in flake.nix (nixfmt + deadnix + statix)
#   toolchain-complete  a binary the dev shell promises no longer resolves
#   project-gate        the repo's own `npm run lint` fails
#
# They live here rather than in flake.nix because flake.nix in this repo is the
# inputs + composition file; `perSystem` concerns get their own module under nix/,
# alongside module.nix and package.nix.
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      self',
      ...
    }:
    let
      toolchain = import ./toolchain.nix { inherit pkgs; };

      # ── Vendored node_modules, so project-gate runs with NO network. ──────────
      # `nix flake check` builds in a sandbox with no network, so `npm install` is
      # not available to the gate; the dependencies have to be in the store before
      # the gate starts.
      #
      # The hash is NOT duplicated here. `buildNpmPackage` exposes the
      # `fetchNpmDeps` derivation it built as `.npmDeps`, so reading it off
      # packages.default means `npmDepsHash` stays declared in exactly one place
      # (nix/package.nix) and a lockfile bump can't leave this file stale.
      #
      # `--ignore-scripts` reaches BOTH `npm ci` and the `npm rebuild` that
      # npmConfigHook runs after it, which is the point: it skips `sharp`'s
      # build-from-source vips compile that package.nix needs and this does not.
      # The gate only ever RESOLVES module paths and parses files — it never loads
      # a native addon — so paying for that compile twice would buy nothing.
      lockSrc = lib.fileset.toSource {
        root = ../.;
        fileset = lib.fileset.unions [
          ../package.json
          ../package-lock.json
        ];
      };

      nodeModules = pkgs.stdenvNoCC.mkDerivation {
        name = "ircc-whatsapp-bot-node-modules";
        src = lockSrc;
        npmDeps = self'.packages.default.npmDeps;
        npmFlags = [ "--ignore-scripts" ];
        # Same reason as package.nix: npm wants to write into its cache dir, which
        # is read-only in the store. Measured — without it `npm ci` dies EACCES on
        # `$npmDeps/_cacache/tmp`.
        makeCacheWritable = true;
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.npmHooks.npmConfigHook
        ];
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp -R node_modules "$out/node_modules"
          runHook postInstall
        '';
      };

      # Narrow fileset: a bare `../.` would copy node_modules/ and the live auth/
      # session (1900 files, both gitignored) into the store on every edit, and
      # rebuild the gate when a file it cannot even see changes.
      gateSrc = lib.fileset.toSource {
        root = ../.;
        fileset = lib.fileset.unions [
          ../package.json
          ../package-lock.json
          ../src
          ../scripts
        ];
      };
    in
    {
      # treefmt-nix's flake-parts module adds its check as `checks.treefmt` when
      # `flakeCheck` is left on. Turned off here only so the same derivation is not
      # exported under two names: the `formatting` attribute below IS that check,
      # built from `config.treefmt.build.check`, not a hand-written reimplementation.
      # `nix fmt` is untouched (`flakeFormatter` stays on).
      treefmt.flakeCheck = false;

      checks = {
        # OFF THE SHELF: treefmt-nix's own `runCommandLocal` that copies the tree,
        # `git init && add && commit`s it, runs `treefmt --no-cache`, then
        # `git diff --exit-code`. `projectRoot` defaults to `self`, so this is
        # byte-for-byte what upstream's `checks.treefmt` would have been.
        # GOES RED WHEN: a tracked file is not formatted as the `treefmt` block in
        # flake.nix says it should be (nixfmt), or trips deadnix/statix.
        formatting = config.treefmt.build.check config.treefmt.projectRoot;

        # Hand-written because nothing off the shelf does it: `mkShell` validates
        # nothing at all, and `devshell`'s `commands` asserts option SHAPE, not that
        # a binary resolves. So this uses the conventional property-assertion idiom
        # — `runCommandLocal` + `nativeBuildInputs` — over the list in toolchain.nix.
        # GOES RED WHEN: a name in `requiredBins` resolves to no binary provided by
        # `packages`, i.e. the dev shell quietly stopped shipping something this
        # project's code or docs invoke by bare name.
        toolchain-complete =
          pkgs.runCommandLocal "ircc-whatsapp-bot-toolchain-complete"
            {
              nativeBuildInputs = toolchain.packages;
            }
            ''
              missing=""
              for bin in ${lib.escapeShellArgs toolchain.requiredBins}; do
                command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"
              done
              if [ -n "$missing" ]; then
                echo "dev shell is missing:$missing" >&2
                echo "add the package that SHIPS each one to nix/toolchain.nix — a package" >&2
                echo "name is not a binary name (nodejs ships node, npm AND npx;" >&2
                echo "postgresql ships psql)." >&2
                exit 1
              fi
              echo "all ${toString (builtins.length toolchain.requiredBins)} required binaries resolve." > "$out"
            '';

        # The repo's own command, run for real. NOT `absent`: this project does have
        # an offline gate (`npm run lint` — scripts/lint.js parses every .js with
        # node's own parser and resolves every bare import with node's own resolver),
        # and the vendored node_modules above is what lets the second half of that
        # run with no network.
        #
        # Deliberately NOT `node src/test-pipeline.js` / `src/simulate.js`: those
        # need an OpenAI key, a reachable pgvector database and live web search, none
        # of which exist in a build sandbox. They stay human-run, per CONTRIBUTING.md.
        # GOES RED WHEN: a .js file fails to parse, or imports a package that is not
        # in package.json — the runtime-only failure CONTRIBUTING.md warns about.
        project-gate =
          pkgs.runCommandLocal "ircc-whatsapp-bot-project-gate"
            {
              nativeBuildInputs = [ pkgs.nodejs ];
            }
            ''
              # The fileset arrives read-only out of the store and npm wants to write
              # beside its inputs, so work on a copy rather than in the store path.
              #
              # INTO A SUBDIRECTORY, and chmod THAT — never the build cwd. Under structured
              # attrs `runCommandLocal`'s cwd also holds Nix's own `builder.json` and
              # `.attr-*`, and the LINUX sandbox refuses to let the builder re-mode them:
              #   chmod: changing permissions of './builder.json': Operation not permitted
              # `chmod -R u+w .` builds fine on darwin, which is how it got written — the
              # first revision of this check was verified on aarch64-darwin only. Measured
              # failing, then passing, on aarch64-linux 2026-10-02.
              mkdir gate
              cp -R ${gateSrc}/. gate/
              chmod -R u+w gate
              cd gate
              ln -s ${nodeModules}/node_modules node_modules
              export HOME="$TMPDIR"
              npm run --silent lint
              touch "$out"
            '';
      };
    };
}
