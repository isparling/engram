import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AtomicWriteDirectorySyncError, atomicWriteFile } from "../src/atomicWrite.ts";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "engram-atomic-write-test-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("writes content that can be read back", async () => {
  const target = join(dir, "record.md");
  await atomicWriteFile(target, "hello\n");
  const content = await readFile(target, "utf8");
  assert.equal(content, "hello\n");
});

test("a second write fully replaces the first and leaves no temp files behind", async () => {
  const target = join(dir, "record2.md");
  await atomicWriteFile(target, "version one\n");
  await atomicWriteFile(target, "version two\n");

  const content = await readFile(target, "utf8");
  assert.equal(content, "version two\n");

  const entries = await readdir(dir);
  const leftoverTemp = entries.filter((e) => e.includes(".tmp-"));
  assert.deepEqual(leftoverTemp, []);
});

// Item 6 of the adversarial review: the temp file was created at open()'s
// default mode, so a record written with restrictive permissions (e.g.
// 0600) silently became 0644 after the first edit.
test("preserves the target file's existing permission mode across a write", async () => {
  const target = join(dir, "restricted.md");
  await writeFile(target, "original\n", "utf8");
  await chmod(target, 0o640);

  const before = await stat(target);
  assert.equal(before.mode & 0o777, 0o640);

  await atomicWriteFile(target, "updated\n");

  const after = await stat(target);
  assert.equal(after.mode & 0o777, 0o640);
  assert.equal(await readFile(target, "utf8"), "updated\n");
});

test("a brand-new target (no prior file) is written without error even though there is no mode to preserve", async () => {
  const target = join(dir, "brand-new.md");
  await atomicWriteFile(target, "content\n");
  assert.equal(await readFile(target, "utf8"), "content\n");
});

// Item 12: a directory-fsync failure after a successful rename must be
// distinguishable from an ordinary write failure so callers can report
// "write landed, index is stale" instead of losing the distinction.
test("AtomicWriteDirectorySyncError carries the underlying cause and a descriptive message", () => {
  const cause = new Error("simulated ENOSPC");
  const error = new AtomicWriteDirectorySyncError("record content was written and renamed into place, but fsync failed", cause);
  assert.equal(error.name, "AtomicWriteDirectorySyncError");
  assert.equal(error.cause, cause);
  assert.match(error.message, /written and renamed into place/);
  assert.ok(error instanceof Error);
});
