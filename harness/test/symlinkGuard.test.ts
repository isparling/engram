// Item 2 of the adversarial review: qmd scans with followSymlinks: true,
// so a symlink inside the bound records root that resolves outside it
// would get indexed into the bound space's qmd collection. This is what
// makes the isolation claim structural rather than aspirational.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { verifyNoSymlinkEscape } from "../src/symlinkGuard.ts";

let root: string;
let outside: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "engram-symlink-test-root-"));
  outside = await mkdtemp(join(tmpdir(), "engram-symlink-test-outside-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("passes for a records root with only plain files", async () => {
  await writeFile(join(root, "plain.md"), "content\n", "utf8");
  const result = await verifyNoSymlinkEscape(root);
  assert.equal(result.ok, true);
});

test("passes for a symlink that resolves inside the records root", async () => {
  await writeFile(join(root, "real.md"), "content\n", "utf8");
  const linkPath = join(root, "alias.md");
  await symlink(join(root, "real.md"), linkPath);
  try {
    const result = await verifyNoSymlinkEscape(root);
    assert.equal(result.ok, true);
  } finally {
    await rm(linkPath, { force: true });
  }
});

test("refuses a symlink that resolves outside the records root", async () => {
  await writeFile(join(outside, "secret.md"), "not part of this space\n", "utf8");
  const linkPath = join(root, "escape.md");
  await symlink(join(outside, "secret.md"), linkPath);
  try {
    const result = await verifyNoSymlinkEscape(root);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((e) => e.includes("escapes the bound records root")));
  } finally {
    await rm(linkPath, { force: true });
  }
});

test("refuses a symlinked directory that resolves outside the records root", async () => {
  const outsideDir = join(outside, "outside-dir");
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, "nested.md"), "content\n", "utf8");

  const linkPath = join(root, "escape-dir");
  await symlink(outsideDir, linkPath);
  try {
    const result = await verifyNoSymlinkEscape(root);
    assert.equal(result.ok, false);
  } finally {
    await rm(linkPath, { force: true });
  }
});

test("finds an escaping symlink nested inside an ordinary subdirectory", async () => {
  const nestedDir = join(root, "nested");
  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(outside, "deep-secret.md"), "content\n", "utf8");
  const linkPath = join(nestedDir, "deep-escape.md");
  await symlink(join(outside, "deep-secret.md"), linkPath);
  try {
    const result = await verifyNoSymlinkEscape(root);
    assert.equal(result.ok, false);
  } finally {
    await rm(linkPath, { force: true });
    await rm(nestedDir, { recursive: true, force: true });
  }
});
