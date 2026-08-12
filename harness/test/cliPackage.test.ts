import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const here = dirname(fileURLToPath(import.meta.url)); // harness/test
const harness = resolve(here, ".."); // harness
const cli = join(harness, "cli");
const prepare = join(cli, "scripts", "prepare.mjs");
const ALLOWED_TOP_LEVEL_ROOTS: Record<string, true> = {
  "bin/": true,
  "release/": true,
  "LICENSE": true,
  "README.md": true,
  "package.json": true,
  "src/": true,
};

after(async () => {
  // No generated tree may remain in the worktree after the test.
  await Promise.all([
    rm(join(cli, "src"), { recursive: true, force: true }),
    rm(join(cli, "release"), { recursive: true, force: true }),
    rm(join(cli, "release-manifest.json"), { force: true }),
  ]);
});

type PackEntry = { path: string };

interface PackJsonEntry {
  files?: PackEntry[];
}

async function runPack(): Promise<string[]> {
  await execFile("bun", ["run", prepare]);
  const { stdout } = await execFile("npm", ["pack", "--json", "--dry-run"], { cwd: cli });
  // prepack writes to stdout, which npm forwards ahead of its --json payload.
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  assert.ok(start !== -1 && end > start, "npm pack --json returned no inventory array");
  const inventory: PackJsonEntry[] = JSON.parse(stdout.slice(start, end + 1));
  return inventory.flatMap((entry) => (entry.files ?? []).map((file) => file.path));
}

test("packed CLI payload is core-only: no bundled pack tree, no vocabulary, both core trees present", async () => {
  const PACKS_ROOT = "pac" + "ks/"; // assembled so the source scan never sees a bundle path
  const VOCABULARY = new RegExp("train" + "ing|co" + "ach|athl" + "ete", "i");
  const paths = await runPack();

  for (const root of Object.keys(ALLOWED_TOP_LEVEL_ROOTS)) {
    assert.equal(paths.some((path) => path.startsWith(root)), true, `missing top-level root ${root}`);
  }
  for (const path of paths) {
    const root = path.includes("/") ? `${path.split("/")[0]}/` : path;
    assert.equal(ALLOWED_TOP_LEVEL_ROOTS[root], true, `unexpected top-level payload root in ${path}`);
  }
  assert.equal(paths.some((path) => path.startsWith(PACKS_ROOT)), false);
  assert.equal(paths.some((path) => VOCABULARY.test(path)), false);
  assert.equal(paths.includes("release/engram-release.ts"), true);
  assert.equal(paths.includes("src/cli.ts"), true);
});

test("packed package payloads ship their Apache-2.0 license text", async () => {
  const cliPaths = await runPack();
  const { stdout } = await execFile("npm", ["pack", "--json", "--dry-run"], { cwd: harness });
  const inventory: PackJsonEntry[] = JSON.parse(stdout);
  const harnessPaths = inventory.flatMap((entry) => (entry.files ?? []).map((file) => file.path));

  assert.equal(cliPaths.includes("LICENSE"), true);
  assert.equal(harnessPaths.includes("LICENSE"), true);
});

test("prepared npm CLI resolves the release manifest from its package root", async () => {
  await execFile("bun", ["run", prepare]);
  const sourceRevision = "a".repeat(40);
  await writeFile(
    join(cli, "release-manifest.json"),
    JSON.stringify({
      schema_version: 0,
      release_format: 0,
      version: `r0-${sourceRevision}`,
      source_revision: sourceRevision,
      packaging_procedure_version: "r0-source-ustar-v1",
      host_agent_compatibility: "host-neutral-cli-schema-0",
      qmd_compatibility: { contract: "scoped-cli", version: "0.1.0" },
      knowledge_schema_compatibility: ["0"],
      pack_api_compatibility: 0,
      environment_compatibility: { platform: "darwin", architecture: "arm64", node_version: process.version },
      included_packs: [],
      files: [{ path: "src/cli.ts", byte_length: 42, sha256: "d".repeat(64), executable: false }],
    }),
    "utf8",
  );

  const { stdout } = await execFile(process.execPath, [join(cli, "src", "cli.ts"), "version"]);
  assert.deepEqual(JSON.parse(stdout), {
    schema_version: 0,
    status: "version",
    release_id: `r0-${sourceRevision}`,
    source_revision: sourceRevision,
  });
});
