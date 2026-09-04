# buildNpmPackage derivation for ircc-whatsapp-bot.
#
# `sharp` (a transitive dep, pulled in by @whiskeysockets/baileys for
# link-preview/sticker image handling) normally downloads a prebuilt libvips
# binary in its postinstall — that needs network, which the Nix build sandbox
# forbids. `--build-from-source` makes it compile against nixpkgs' own `vips`
# instead (the standard nixpkgs fix for sharp-based packages).
{
  lib,
  buildNpmPackage,
  nodejs,
  vips,
  pkg-config,
  python3,
}:
buildNpmPackage {
  pname = "ircc-whatsapp-bot";
  version = "0.1.0";
  src = ../.;

  npmDepsHash = "sha256-mm0ydL2UeviP4eU0oor1GHHVG1UhMugN+1D3X6ypIy4=";

  # No "build" script in package.json — plain JS, nothing to bundle.
  dontNpmBuild = true;

  # sharp's native (--build-from-source) compile writes node-gyp temp files
  # into the npm cache dir, which is otherwise read-only in the store.
  makeCacheWritable = true;

  nativeBuildInputs = [
    pkg-config
    python3
  ];
  buildInputs = [ vips ];
  npmFlags = [ "--build-from-source" ];

  inherit nodejs;

  meta = {
    description = "WhatsApp bot answering Canadian immigration questions, grounded in official IRCC content via a local pgvector RAG store";
    homepage = "https://github.com/kattakath/ircc-whatsapp-bot";
    mainProgram = "ircc-whatsapp-bot";
  };
}
