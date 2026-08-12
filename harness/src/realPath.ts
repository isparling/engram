// Real-path helpers that resolve symlinks before containment checks, so an
// escaping path is caught no matter how it is spelled.
//
// qmd resolves symlinks before storing or comparing collection paths (see
// qmd.ts's getRealPath: realpath, falling back to a plain resolve() if
// the path doesn't exist yet) — e.g. it stores the collection root's
// REAL path in index.yml, not whatever path string it was given. Any
// comparison against something qmd wrote must apply the same resolution,
// or a symlinked path component (macOS puts the whole OS temp directory
// under /var, itself a symlink to /private/var) produces spurious
// mismatches: two paths that are the same real location compare unequal
// because only one of them had its symlinks followed.

import { stat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

export async function realOrResolvedPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True iff two paths name the same directory on disk, compared by
 * filesystem identity (device + inode) rather than string equality.
 * String/realpath comparison alone is insufficient on macOS: APFS
 * firmlinks make `/Users/<user>/.config/qmd` and
 * `/System/Volumes/Data/Users/<user>/.config/qmd` two different path
 * strings (and different realpath() results — realpath does not resolve
 * firmlinks) that are nonetheless the same directory.
 *
 * If either path can't be stat'd (doesn't exist, no permission), identity
 * can't be proven either way, so this falls back to a resolved-path
 * string comparison rather than silently treating "unprovable" as either
 * "same" or "different".
 */
export async function isSameDirectory(pathA: string, pathB: string): Promise<boolean> {
  try {
    const [statA, statB] = await Promise.all([stat(pathA), stat(pathB)]);
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    const [resolvedA, resolvedB] = await Promise.all([realOrResolvedPath(pathA), realOrResolvedPath(pathB)]);
    return resolvedA === resolvedB;
  }
}
