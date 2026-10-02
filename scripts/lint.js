#!/usr/bin/env node
// `npm run lint` — the repo's own offline gate, and the thing `checks.project-gate`
// runs inside the Nix sandbox (see nix/checks.nix).
//
// It asserts the two things that are checkable with NO network, NO database, NO
// OpenAI key and NO paired WhatsApp session — i.e. everything `src/test-pipeline.js`
// and `src/simulate.js` cannot be, which is why they are not the gate:
//
//   1. Every .js file PARSES, using Node's own parser (`node --check`). Not a
//      hand-rolled syntax checker, and not a third-party linter either: a linter
//      with no config in a never-linted tree would go red on style, which makes a
//      gate nobody can keep green.
//   2. Every BARE import specifier RESOLVES, using Node's own resolver
//      (`import.meta.resolve`). This is the drift CONTRIBUTING.md warns about in
//      another form: add `import x from "some-pkg"` and forget `package.json`, and
//      the bot dies at runtime on a user's first message. Here it dies in CI.
//
// Specifier extraction is a deliberately conservative REGEX, not a parser. It can
// only MISS an import, never invent one — so a failure it reports is always a real
// unresolvable specifier, and the worst a miss costs is a check that was less
// thorough than it could have been. A real ES-module lexer would be a new runtime
// dependency for a lint, which is a worse trade.
//
// Two measured reasons it is anchored at LINE START and filtered by a package-name
// shape, rather than matching `from "..."` anywhere:
//   - `src/llm.js`'s system prompt contains the English words `from "how do I
//     apply"` inside a template literal. An unanchored match reported that as a
//     missing dependency.
//   - A `//`-comment showing an example import would match too. Anchoring at
//     `^\s*import` skips comment and prose lines without a comment stripper, which
//     would itself mangle the `https://` URLs this crawler is full of.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["src", "scripts"];
const builtins = new Set(builtinModules);

/** Every *.js under `dir`, recursively. `node_modules` is never descended into. */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// Statement-position imports only: a line that STARTS with `import`, optionally
// `from`-clause'd, or a top-level `const x = require(...)`.
const SPECIFIER_RE =
  /^[ \t]*(?:import[\s\S]*?from[ \t]*|import[ \t]*|(?:const|let|var)\s+[^=\n]+=\s*require[ \t]*\(\s*)(["'])([^"'\n]+)\1/gm;

// npm package specifier shape (optionally scoped, optionally with a subpath). A
// string with spaces in it — i.e. English prose — can never match.
const PACKAGE_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/[^\s]*)?$/;

const files = ROOTS.filter((d) => {
  try {
    return statSync(join(root, d)).isDirectory();
  } catch {
    return false;
  }
}).flatMap((d) => jsFiles(join(root, d)));

if (files.length === 0) {
  console.error("lint: found no .js files under " + ROOTS.join(", "));
  process.exit(1);
}

const problems = [];

for (const file of files) {
  const rel = file.slice(root.length + 1);

  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    problems.push(`${rel}: parse error\n${String(err.stderr ?? err.message).trim()}`);
    continue; // an unparseable file has no trustworthy import list
  }

  const source = readFileSync(file, "utf8");
  const parent = pathToFileURL(file);
  const seen = new Set();
  for (const [, , spec] of source.matchAll(SPECIFIER_RE)) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    // Relative/absolute paths and builtins are not dependency drift.
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    if (spec.startsWith("node:") || builtins.has(spec)) continue;
    if (!PACKAGE_RE.test(spec)) continue;
    try {
      import.meta.resolve(spec, parent);
    } catch {
      problems.push(`${rel}: unresolvable dependency ${JSON.stringify(spec)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`lint: ${problems.length} problem(s) in ${files.length} file(s):`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

console.log(`lint: ${files.length} file(s) parse, every bare import resolves.`);
