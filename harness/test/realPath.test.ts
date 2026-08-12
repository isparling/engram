// Fix 2 (adversarial review, cycle 3): default-location checks must compare
// by filesystem identity (device + inode), not string equality, because
// two different path strings can name the same directory. This is
// verified portably here via a symlink (works on any POSIX filesystem);
// qmdConfigGuard.test.ts additionally verifies the real macOS firmlink
// case this was reported against.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { isSameDirectory, realOrResolvedPath } from "../src/realPath.ts";

let dir: string;
let realDir: string;
let linkToRealDir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "engram-realpath-test-"));
  realDir = join(dir, "real");
  linkToRealDir = join(dir, "link-to-real");
  await mkdir(realDir, { recursive: true });
  await symlink(realDir, linkToRealDir);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("isSameDirectory is true for a path compared to itself", async () => {
  assert.equal(await isSameDirectory(realDir, realDir), true);
});

test("isSameDirectory is true for a directory and a symlink pointing at it, despite different path strings", async () => {
  assert.notEqual(realDir, linkToRealDir);
  assert.equal(await isSameDirectory(realDir, linkToRealDir), true);
  assert.equal(await isSameDirectory(linkToRealDir, realDir), true);
});

test("isSameDirectory is false for two distinct real directories", async () => {
  const other = join(dir, "other");
  await mkdir(other, { recursive: true });
  assert.equal(await isSameDirectory(realDir, other), false);
});

test("isSameDirectory falls back to resolved-path comparison when a path doesn't exist, rather than throwing", async () => {
  const missingA = join(dir, "does-not-exist-a");
  const missingB = join(dir, "does-not-exist-b");
  assert.equal(await isSameDirectory(missingA, missingA), true);
  assert.equal(await isSameDirectory(missingA, missingB), false);
});

test("realOrResolvedPath resolves an ordinary symlink to its target (sanity check: real symlinks ARE followed, unlike macOS firmlinks)", async () => {
  // Compare against realOrResolvedPath(realDir), not the raw realDir
  // string: the OS temp directory itself may contain an unrelated
  // symlinked path component (macOS: /var -> /private/var), which
  // realpath legitimately resolves too and would make a literal-string
  // comparison fail for a reason unrelated to what this test checks.
  const resolvedLink = await realOrResolvedPath(linkToRealDir);
  const resolvedTarget = await realOrResolvedPath(realDir);
  assert.equal(resolvedLink, resolvedTarget);
  assert.ok(resolvedLink.endsWith("/real"));
});
