// The minimal effective binding used by Markdown and qmd operations. The
// durable manifest/registry layer resolves this shape in spaceRegistry.ts;
// knowledge-facing CLI commands never accept these paths directly.

import { join, resolve, sep } from "node:path";
import { err, ok, type Result } from "./types.ts";

export type SpaceBinding = {
  recordsRoot: string;
  qmdConfigDir: string;
  qmdCacheHome: string;
  qmdCollectionName: string;
};

const RECORD_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Resolves a candidate's target_id to an absolute file path inside the
 * bound records root. Rejects anything that is not a bare kebab-case id
 * (no path separators, no "..") and, as defense in depth, rejects any
 * resolved path that does not stay under the bound root.
 */
export function resolveRecordPath(binding: SpaceBinding, recordId: string): Result<string> {
  if (!RECORD_ID_PATTERN.test(recordId)) {
    return err([`invalid record id: ${JSON.stringify(recordId)} (must match ${RECORD_ID_PATTERN})`]);
  }

  const candidatePath = join(binding.recordsRoot, `${recordId}.md`);
  const resolvedRoot = resolve(binding.recordsRoot) + sep;
  const resolvedPath = resolve(candidatePath);

  if (!resolvedPath.startsWith(resolvedRoot)) {
    return err([`record id resolves outside the bound records root: ${JSON.stringify(recordId)}`]);
  }

  return ok(resolvedPath);
}
