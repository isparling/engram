// Generates the self-contained package tree for @isparling/engram-cli.
//
// The CLI entry (harness/src/cli.ts) and its dependency graph span two
// roots in the repo: harness/src/* and release/engram-release.ts. npm
// packages cannot reference files outside their own directory, so this
// prepack script vendors copies of everything the CLI needs into the
// package and rewrites the single cross-root import path to resolve within
// it. Pack resolution is external-only — the core ships no bundled pack
// tree.
//
// The rewrite set is deliberately small and fixed:
//   - src/cli.ts:  ../../release/engram-release.ts -> ../release/engram-release.ts
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // harness/cli/scripts
const cliPkg = resolve(here, ".."); // harness/cli
const root = resolve(cliPkg, "..", ".."); // repo root
const srcRoot = join(root, "harness", "src");
const releaseRoot = join(root, "release");

// Wipe generated dirs first so stale files never survive a later pack.
for (const name of ["src", "release"]) {
  const dir = join(cliPkg, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

// 1. Every harness src module the CLI may reach.
for (const file of await readdir(srcRoot)) {
  if (file.endsWith(".ts")) await copyFile(join(srcRoot, file), join(cliPkg, "src", file));
}

// 2. The release-manifest reader (imports Node builtins only; self-contained).
await copyFile(join(releaseRoot, "engram-release.ts"), join(cliPkg, "release", "engram-release.ts"));

// 3. Rewrite cross-root imports in the copied files.
const rewrites = new Map([
  [join(cliPkg, "src", "cli.ts"), [
    ["../../release/engram-release.ts", "../release/engram-release.ts"],
  ]],
]);

for (const [file, pairs] of rewrites) {
  let text = await readFile(file, "utf8");
  for (const [from, to] of pairs) text = text.replaceAll(from, to);
  await writeFile(file, text);
}

console.log("prepped @isparling/engram-cli tree");
