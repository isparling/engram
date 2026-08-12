// The one operation:
//   submit a candidate against an existing Markdown record
//     -> classify the change as additive or non-additive
//     -> render the complete diff
//     -> gate on approval when non-additive
//     -> write atomically
//     -> refresh qmd once
//     -> report fresh or index-stale
//
// Markdown is authoritative, qmd is derived. A refresh failure after a valid
// write never rolls back that write; it is reported as index-stale and the
// committed Markdown stands.
//
// Approval integrity: `approval_required` carries a `plan_hash` covering
// BOTH endpoints of the diff — the record bytes read and the bytes that
// would replace them. A non-additive candidate can only be committed with
// `approve: true` if `expectHash` matches the plan recomputed at commit
// time. Anything that changes the mutation invalidates the approval: the
// record changing on disk, a different candidate being submitted, or a
// submission date that alters the result.
//
// Hashing the record alone was insufficient and shipped as a defect: it
// caught a changed record but let a caller preview candidate A and then
// approve candidate B using A's hash, committing a diff never shown.

import { lstat, realpath, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { sep } from "node:path";
import { AtomicWriteDirectorySyncError, atomicWriteFile } from "./atomicWrite.ts";
import { validateCandidate, type Candidate } from "./candidate.ts";
import type { Classification } from "./classify.ts";
import { planMutation } from "./classify.ts";
import { hashPlan } from "./contentHash.ts";
import { parseRecord } from "./markdownRecord.ts";
import { REFRESH_NOT_ATTEMPTED, refreshQmdCollection, type FreshnessRefreshReport, type RefreshReport, type SpawnFn } from "./qmdRunner.ts";
import { resolveRecordPath, type SpaceBinding } from "./spaceBinding.ts";

/** Same shape as atomicWriteFile. Overridable so tests can simulate a
 * post-rename directory-fsync failure (AtomicWriteDirectorySyncError)
 * deterministically, the same way qmdRunner's spawnFn lets tests simulate
 * a spawn failure — both are OS-boundary failures that are impractical to
 * trigger reliably through real fault injection in a portable test. */
export type WriteRecordFn = (targetPath: string, content: string) => Promise<void>;

export type SubmitOutcome =
  | {
      schema_version: 0;
      status: "invalid";
      errors: string[];
      refresh: RefreshReport;
    }
  | {
      schema_version: 0;
      status: "approval_required";
      record_id: string;
      classification: "non-additive";
      diff: string;
      plan_hash: string;
      refresh: RefreshReport;
    }
  | {
      schema_version: 0;
      status: "stale_approval";
      record_id: string;
      classification: "non-additive";
      diff: string;
      expected_plan_hash: string;
      actual_plan_hash: string;
      reason: string;
      refresh: RefreshReport;
    }
  | {
      schema_version: 0;
      status: "committed";
      record_id: string;
      classification: Classification;
      diff: string;
      written_path: string;
      refresh: FreshnessRefreshReport;
    };

export type SubmitInput = {
  binding: SpaceBinding;
  candidateInput: unknown;
  approve: boolean;
  /** Required when approve is true and the candidate turns out
   * non-additive: must equal the plan_hash from a prior approval_required
   * result, or the commit is refused as stale. */
  expectHash?: string;
  /** YYYY-MM-DD. Passed explicitly (never sampled internally) so results are deterministic under test. */
  submittedAt: string;
  /** Testing seam: overrides the real atomic write. Defaults to atomicWriteFile. */
  writeRecord?: WriteRecordFn;
  /** Testing seam: overrides the real qmd spawn function used for refresh. Defaults to the real child_process.spawn. */
  spawnFn?: SpawnFn;
};

function invalid(errors: string[]): SubmitOutcome {
  return { schema_version: 0, status: "invalid", errors, refresh: REFRESH_NOT_ATTEMPTED };
}

export async function submitCandidate(input: SubmitInput): Promise<SubmitOutcome> {
  const candidateResult = validateCandidate(input.candidateInput);
  if (!candidateResult.ok) {
    return invalid(candidateResult.errors);
  }
  const candidate: Candidate = candidateResult.value;

  const pathResult = resolveRecordPath(input.binding, candidate.target_id);
  if (!pathResult.ok) {
    return invalid(pathResult.errors);
  }
  const recordPath = pathResult.value;

  let recordsRoot: string;
  let recordStat: Stats;
  try {
    [recordsRoot, recordStat] = await Promise.all([realpath(input.binding.recordsRoot), lstat(recordPath)]);
  } catch {
    return invalid([`record not found for target_id: ${candidate.target_id}`]);
  }
  if (recordStat.isSymbolicLink()) {
    return invalid([`record target must not be a symbolic link: ${candidate.target_id}`]);
  }
  let canonicalRecordPath: string;
  try {
    canonicalRecordPath = await realpath(recordPath);
  } catch {
    return invalid([`record target could not be resolved: ${candidate.target_id}`]);
  }
  const rootPrefix = recordsRoot.endsWith(sep) ? recordsRoot : recordsRoot + sep;
  if (!canonicalRecordPath.startsWith(rootPrefix)) {
    return invalid([`record target resolves outside the bound records root: ${candidate.target_id}`]);
  }

  // Read as bytes: the plan hash covers the record exactly as it is on disk,
  // and decoding first would collapse distinct invalid UTF-8 sequences.
  const recordBytes = await readFile(recordPath);
  const recordText = recordBytes.toString("utf8");

  const recordResult = parseRecord(recordText);
  if (!recordResult.ok) {
    return invalid(recordResult.errors);
  }

  const planResult = planMutation(recordText, recordResult.value, candidate, input.submittedAt);
  if (!planResult.ok) {
    return invalid(planResult.errors);
  }
  const plan = planResult.value;

  // Covers destination and both endpoints of the diff, so approval cannot
  // carry across to a different space, a different candidate, a changed
  // record, or a different submission date.
  const planHash = hashPlan(recordPath, recordBytes, plan.afterText);

  if (plan.classification === "non-additive") {
    if (!input.approve) {
      return {
        schema_version: 0,
        status: "approval_required",
        record_id: candidate.target_id,
        classification: "non-additive",
        diff: plan.diff,
        plan_hash: planHash,
        refresh: REFRESH_NOT_ATTEMPTED,
      };
    }

    if (input.expectHash === undefined) {
      return invalid([
        "--approve on a non-additive candidate requires --expect <hash>, using the plan_hash from a prior approval_required result",
      ]);
    }

    if (input.expectHash !== planHash) {
      return {
        schema_version: 0,
        status: "stale_approval",
        record_id: candidate.target_id,
        classification: "non-additive",
        diff: plan.diff,
        expected_plan_hash: input.expectHash,
        actual_plan_hash: planHash,
        reason:
          "the mutation is not the one that was approved; the record changed on disk, " +
          "the candidate differs from the one previewed, or the submission date alters the result",
        refresh: REFRESH_NOT_ATTEMPTED,
      };
    }
  }

  const writeRecord = input.writeRecord ?? atomicWriteFile;

  try {
    await writeRecord(recordPath, plan.afterText);
  } catch (error) {
    if (error instanceof AtomicWriteDirectorySyncError) {
      return {
        schema_version: 0,
        status: "committed",
        record_id: candidate.target_id,
        classification: plan.classification,
        diff: plan.diff,
        written_path: recordPath,
        refresh: {
          attempted: false,
          count: 0,
          state: "index-stale",
          detail: `refresh skipped: ${error.message}`,
        },
      };
    }
    throw error;
  }

  const refresh = await refreshQmdCollection(input.binding, input.spawnFn);

  return {
    schema_version: 0,
    status: "committed",
    record_id: candidate.target_id,
    classification: plan.classification,
    diff: plan.diff,
    written_path: recordPath,
    refresh,
  };
}
