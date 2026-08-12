// Atomic file replacement that preserves the target's permission bits.
//
// Atomic write: temp file in the same directory as the
// target -> fsync the file descriptor -> rename -> fsync the containing
// directory. The rename is what makes the write atomic from the point of
// view of any reader; the two fsyncs are what make it durable across a
// crash rather than merely atomic in memory.
//
// The temp file's mode is set to match the target's existing mode before
// the rename, so a record that was e.g. 0600 doesn't silently become
// 0644 (open()'s default, subject to umask) after a routine edit.
//
// Concurrency note (explicitly out of scope, not solved here): the write
// path is single-writer. Two concurrent submitCandidate calls against the
// same record both read-plan-write independently; the second rename simply
// wins and the first writer's change is lost without conflict detection.
// That is accepted for the single-user core, not fixed.

import { open, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Thrown when the temp file was written, fsynced, and successfully
 * renamed over the target — the new content is live and readable — but
 * the final fsync of the containing directory failed. The write is not
 * rolled back (a valid write is never undone to make something else
 * look healthy); callers should treat the record as committed but treat
 * anything depending on this write's crash-durability, including the
 * subsequent qmd refresh, as unsafe to attempt.
 */
export class AtomicWriteDirectorySyncError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "AtomicWriteDirectorySyncError";
    this.cause = cause;
  }
}

export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const dir = dirname(targetPath);
  const tmpPath = join(dir, `.${basename(targetPath)}.tmp-${randomBytes(8).toString("hex")}`);

  let targetMode: number | undefined;
  try {
    const targetStat = await stat(targetPath);
    targetMode = targetStat.mode & 0o777;
  } catch {
    targetMode = undefined; // target does not exist yet; nothing to preserve
  }

  const fileHandle = await open(tmpPath, "w");
  try {
    await fileHandle.writeFile(content, "utf8");
    if (targetMode !== undefined) {
      await fileHandle.chmod(targetMode);
    }
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  await rename(tmpPath, targetPath);

  try {
    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (error) {
    throw new AtomicWriteDirectorySyncError(
      "record content was written and renamed into place, but fsync of the containing directory failed afterward; the write is not rolled back, but its crash-durability is unconfirmed",
      error,
    );
  }
}
