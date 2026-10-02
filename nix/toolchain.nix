# The dev toolchain, declared exactly ONCE.
#
# Two readers, deliberately:
#   * flake.nix's `devShells.default` — what a human gets from `nix develop`.
#   * nix/checks.nix's `toolchain-complete` — what CI asserts still resolves.
#
# A second copy of this list in either place is what that check exists to make
# impossible: it would then be asserting against its own copy instead of against
# the shell, i.e. against nothing.
#
# Not a flake-parts module on purpose — it carries no flake outputs, just data two
# modules need, so a plain `pkgs`-taking function is the smaller thing that works.
{ pkgs }:
{
  packages = [
    pkgs.nodejs # node, npm, npx — package.json's `engines.node` is >=22
    pkgs.postgresql # psql, for poking the pgvector RAG store by hand
  ];

  # The BINARY names the above must put on PATH, and that this project's own code
  # and docs shell out to by bare name:
  #   node  — scripts/recrawl.js execFileSync's bare "node"
  #   npm   — CONTRIBUTING.md's dev loop (`npm install`, `npm run lint`)
  #   npx   — ad-hoc tooling; ships with nodejs, so dropping nodejs drops it too
  #   psql  — README's RAG-store inspection steps
  #
  # Writing them down is the whole of what turns `toolchain-complete` from a
  # tautology into a gate, because a PACKAGE name is not a BINARY name: one
  # `pkgs.nodejs` entry above is responsible for three of the four names here, and
  # `pkgs.postgresql` for a `psql` that appears nowhere in its attribute name.
  requiredBins = [
    "node"
    "npm"
    "npx"
    "psql"
  ];
}
