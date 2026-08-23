// Artifact-root-confined atomic replacement: the write mechanic pack
// materializers use to regenerate compatibility views (prescription YAML,
// consultation logs, ...) from committed records.
//
// Authorization layering, in order:
//
// 1. The requested root is pack-selected configuration — it may name any
//    directory — but it is only ever a candidate. The binding remains the
//    final authorization boundary: the canonicalized root must sit inside an
//    active `writeRoot` AND inside the space root, or the request is refused.
// 2. Every existing parent of the target is resolved with realpath and must
//    stay inside the canonicalized root, so a symlinked directory cannot move
//    the write outside even when its destination is itself inside the binding.
// 3. A symlinked target is refused outright rather than written through.
// 4. Current bytes are compared first; atomicWriteFile runs only on a real
//    change, so repeated materialization is a byte-identical no-op.

import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteFile } from "./atomicWrite.ts";
import type { ActiveSpace } from "./spaceRegistry.ts";
import type { ArtifactReplacementResult } from "./captureTypes.ts";
import type { KnowledgeError, KnowledgeResult } from "./knowledgeTypes.ts";

export type ArtifactReplacementRequest = {
  root: string;
  relativePath: string;
  content: string;
};

function artifactError(code: string, message: string, field?: string): KnowledgeError {
  return field === undefined
    ? { kind: "artifact", code, message }
    : { kind: "artifact", code, field, message };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

// Same containment test spaceRegistry uses for binding validation: relative()
// based, so a candidate equals-or-under check cannot be fooled by ".." or
// absolute spellings.
function containsPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

export async function replaceArtifact(
  active: ActiveSpace,
  request: ArtifactReplacementRequest,
): Promise<KnowledgeResult<ArtifactReplacementResult>> {
  if (!isAbsolute(request.root)) {
    return { ok: false, errors: [artifactError("artifact_root_invalid", "root must be an absolute path", "root")] };
  }
  const segments = request.relativePath.split("/");
  if (
    request.relativePath.length === 0 ||
    request.relativePath.includes("\\") ||
    request.relativePath.includes("\u0000") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return {
      ok: false,
      errors: [artifactError(
        "relative_path_invalid",
        "relativePath must be a normalized relative path without .., ., empty, backslash, or NUL segments",
        "relativePath",
      )],
    };
  }

  // Canonicalize the requested root before any comparison: every containment
  // decision below compares real paths so a symlinked path component cannot
  // make two locations that are the same directory compare unequal — or two
  // different directories compare equal.
  let rootReal: string;
  try {
    rootReal = await realpath(request.root);
  } catch (error) {
    return {
      ok: false,
      errors: [artifactError("artifact_root_unavailable", `root could not be resolved: ${error instanceof Error ? error.message : String(error)}`, "root")],
    };
  }
  if (!(await stat(rootReal)).isDirectory()) {
    return { ok: false, errors: [artifactError("artifact_root_invalid", "root must name a directory", "root")] };
  }

  // The requested root is configuration; the binding authorizes it.
  if (!active.writeRoots.some((writeRoot) => containsPath(writeRoot, rootReal))) {
    return {
      ok: false,
      errors: [artifactError("root_not_writable", `requested artifact root is not inside an active write root: ${request.root}`, "root")],
    };
  }
  if (!containsPath(active.spaceRoot, rootReal)) {
    return {
      ok: false,
      errors: [artifactError("root_outside_space", `requested artifact root is outside the active space root: ${request.root}`, "root")],
    };
  }

  // Resolve the deepest existing ancestor lexically, then realpath it: if any
  // existing ancestor is a symlink, its resolved location must still be inside
  // the canonicalized root. New (not-yet-existing) trailing components are
  // appended under that resolved location.
  const dirSegments = segments.slice(0, -1);
  const fileName = requireSegment(segments, segments.length - 1);
  let existingCount = 0;
  let ancestor = rootReal;
  while (existingCount < dirSegments.length) {
    const next = join(ancestor, requireSegment(dirSegments, existingCount));
    try {
      await lstat(next);
    } catch {
      break;
    }
    ancestor = next;
    existingCount++;
  }
  let ancestorReal: string;
  try {
    ancestorReal = await realpath(ancestor);
  } catch (error) {
    return {
      ok: false,
      errors: [artifactError("parent_resolution_failed", `parent directory could not be resolved: ${error instanceof Error ? error.message : String(error)}`, "relativePath")],
    };
  }
  if (!containsPath(rootReal, ancestorReal)) {
    return {
      ok: false,
      errors: [artifactError("parent_escape", `a parent directory resolves outside the requested artifact root: ${request.root}/${request.relativePath}`, "relativePath")],
    };
  }

  const targetPath = join(ancestorReal, ...dirSegments.slice(existingCount), fileName);

  // Refuse a symlinked target outright: replacement means "these bytes at this
  // path", never "follow this link and clobber whatever it names".
  try {
    const targetStat = await lstat(targetPath);
    if (targetStat.isSymbolicLink()) {
      return {
        ok: false,
        errors: [artifactError("target_symlink", `target path is a symbolic link and will not be written through: ${request.relativePath}`, "relativePath")],
      };
    }
  } catch (error) {
    if (!isMissing(error)) {
      return {
        ok: false,
        errors: [artifactError("target_stat_failed", `target could not be inspected: ${error instanceof Error ? error.message : String(error)}`, "relativePath")],
      };
    }
  }

  let current: string | undefined;
  try {
    current = await readFile(targetPath, "utf8");
  } catch (error) {
    if (!isMissing(error)) {
      return {
        ok: false,
        errors: [artifactError("current_read_failed", `current artifact bytes could not be read: ${error instanceof Error ? error.message : String(error)}`, "relativePath")],
      };
    }
  }
  if (current === request.content) {
    return { ok: true, value: { status: "unchanged", path: displayPath(request.root, segments) } };
  }

  // Materialized views live in nested paths that may not exist yet; the
  // confinement checks above already validated every existing ancestor, so
  // creating the remaining directories under the resolved location is safe.
  try {
    await mkdir(dirname(targetPath), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      errors: [artifactError("parent_create_failed", `parent directory could not be created: ${error instanceof Error ? error.message : String(error)}`, "relativePath")],
    };
  }

  try {
    await atomicWriteFile(targetPath, request.content);
  } catch (error) {
    return {
      ok: false,
      errors: [artifactError("artifact_write_failed", `atomic artifact write failed; previous bytes are untouched: ${error instanceof Error ? error.message : String(error)}`, "relativePath")],
    };
  }
  return { ok: true, value: { status: "replaced", path: displayPath(request.root, segments) } };
}

function requireSegment(segments: readonly string[], index: number): string {
  const segment = segments[index];
  if (segment === undefined) throw new Error(`internal invariant violated: segment ${index} must exist within relativePath`);
  return segment;
}

// The reported path mirrors the caller's spelling (requested root + relative
// path), not the internal resolved location: confinement decisions used real
// paths, but the caller asked about this path.
function displayPath(root: string, segments: readonly string[]): string {
  return resolve(root, ...segments);
}
