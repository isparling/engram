// Symlink guard: a symlink inside the records root that resolves outside it is
// refused before any scanning qmd command runs.
//
// qmd scans collections with `followSymlinks: true` (qmd.ts's indexFiles,
// via Glob.scan). A symlink inside the bound records root that resolves
// outside it would therefore get indexed into the bound space's qmd
// collection — silently widening what "the bound space" actually covers.
// This walk runs before any qmd command that scans the filesystem
// (`collection add`, `update`) and refuses if it finds one. Records roots
// are small synthetic fixtures/spaces, so a full walk on every such call is
// cheap; this is not meant to scale to large corpora.

import { readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { realOrResolvedPath } from "./realPath.ts";
import { err, ok, type Result } from "./types.ts";

export async function verifyNoSymlinkEscape(recordsRoot: string): Promise<Result<void>> {
  // A symlink target is always fully resolved by realpath(), so the root
  // it's compared against must be too, or a symlinked path component
  // (macOS's /var -> /private/var, which every OS temp directory lives
  // under) makes an entirely-internal symlink look like an escape.
  const resolvedRoot = await realOrResolvedPath(recordsRoot);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  const errors: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      errors.push(`failed to read directory while checking for escaping symlinks: ${dir} (${describeError(error)})`);
      return;
    }

    for (const entry of entries) {
      const entryPath = join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(entryPath);
        } catch (error) {
          errors.push(`symlink could not be resolved: ${entryPath} (${describeError(error)})`);
          continue;
        }
        if (target !== resolvedRoot && !target.startsWith(rootWithSep)) {
          errors.push(`symlink escapes the bound records root: ${entryPath} -> ${target}`);
        }
        // Do not follow into (or through) a symlink even if it happens to
        // resolve inside the root — only plain directories are walked
        // further, so a symlink cannot be used to reintroduce a deeper
        // escaping symlink under a name this walk already accepted.
        continue;
      }

      if (entry.isDirectory()) {
        await walk(entryPath);
      }
    }
  }

  await walk(resolvedRoot);

  if (errors.length > 0) return err(errors);
  return ok(undefined);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
