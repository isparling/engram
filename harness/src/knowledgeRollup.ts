// A stateless, reviewable, ordered preview over a batch of knowledge
// candidates. This module composes the existing per-candidate transaction
// (`reconcileKnowledgeTransaction`) rather than re-implementing
// plan-building, diffing, or hashing: it privately prepares one ordered
// `KnowledgeProposal` per candidate, renders the complete diff for every
// mutation, and hashes the ordered (candidate id, plan hash) pairs so a
// caller can review and later re-approve the exact same batch.
//
// Public output is path-free by construction: `RollupReviewMutation` never
// carries `PlannedMutation.path`, only the record id and the rendered diff
// lines. The private `prepareKnowledgeRollup` additionally returns the
// ordered internal proposals the approval pass needs to apply the batch;
// those proposals are never exported.

import { createHash } from "node:crypto";
import { canonicalJson } from "./knowledgeRecord.ts";
import {
  applyKnowledgeProposal,
  reconcileKnowledgeTransaction,
  type ApplyKnowledgeOutcome,
  type KnowledgeProposal,
  type PlannedMutation,
  type ReconcileOutcome,
} from "./knowledgeTransaction.ts";
import { renderUnifiedDiff } from "./diff.ts";
import type { ActiveSpace } from "./spaceRegistry.ts";
import type { KnowledgeDisposition, KnowledgeError, KnowledgePack, KnowledgeResult } from "./knowledgeTypes.ts";
import { embedBoundCollection, type EmbedReport, type RefreshReport, type SpawnFn } from "./qmdRunner.ts";
import { requireDefined } from "./types.ts";

export type RollupClassification = "no-change" | "additive" | "non-additive";

export type KnowledgeRollupInput = {
  schema_version: 0;
  candidates: unknown[];
};

export type RollupReviewMutation = {
  action: "create" | "update";
  record_id: string;
  diff: string[];
};

export type RollupReviewItem = {
  index: number;
  candidate_id: string;
  plan_hash: string;
  classification: RollupClassification;
  disposition: KnowledgeDisposition;
  summary: string;
  mutations: RollupReviewMutation[];
};

export type KnowledgeRollupPreview = {
  schema_version: 0;
  status: "preview";
  rollup_hash: string;
  classification: RollupClassification;
  approval_required: boolean;
  items: RollupReviewItem[];
};

export type RollupPreparationFailure = {
  schema_version: 0;
  status: "invalid" | "retrieval_failed";
  failed_index?: number;
  failed_candidate_id?: string;
  errors: KnowledgeError[];
};

/** One ordered, successfully reconciled batch member: kept private so a preview never leaks a full proposal. */
type PreparedItem = {
  candidateId: string;
  proposal: KnowledgeProposal;
};

type PreparedRollup = {
  preview: KnowledgeRollupPreview;
  items: readonly PreparedItem[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rollupError(code: string, message: string, field?: string): KnowledgeError {
  return field === undefined ? { kind: "validation", code, message } : { kind: "validation", code, field, message };
}

/**
 * `reconcileKnowledgeTransaction`'s errors are an internal contract, not a
 * public one: several transaction-layer codes (see `readCurrent` in
 * knowledgeTransaction.ts, e.g. `path_escape`, `record_read_failed`,
 * `record_shape_invalid`, `record_invalid`) embed the absolute on-disk
 * record path directly into both `message` and `field`. `RollupPreparationFailure`
 * is public, so every non-proposal outcome's errors are rewritten here to a
 * fixed, code-derived message with no `field` at all before they leave this
 * module — `kind` and `code` are the only parts of the original error kept
 * verbatim, and neither can carry an interpolated path.
 */
function sanitizeRollupError(error: KnowledgeError): KnowledgeError {
  return { kind: error.kind, code: error.code, message: `rollup candidate preparation failed: ${error.code}` };
}

const ROLLUP_TOP_LEVEL_KEYS = ["schema_version", "candidates"];

/**
 * Structural, cast-free wrapper validation. Only checks the batch envelope
 * (exactly `schema_version`/`candidates`, a non-empty candidate array, and
 * that every candidate carries a unique non-empty string `id`) — full
 * candidate shape validation stays owned by `reconcileKnowledgeTransaction`.
 */
function validateRollupInput(
  raw: unknown,
): KnowledgeResult<{ candidates: KnowledgeRollupInput["candidates"]; candidateIds: string[] }> {
  if (!isObject(raw)) {
    return { ok: false, errors: [rollupError("rollup_shape_invalid", "rollup batch must be an object with schema_version and candidates")] };
  }
  const errors: KnowledgeError[] = [];
  for (const key of Object.keys(raw).filter((candidateKey) => !ROLLUP_TOP_LEVEL_KEYS.includes(candidateKey))) {
    errors.push(rollupError("rollup_unknown_field", `rollup batch contains unknown field ${key}`, key));
  }
  if (raw.schema_version !== 0) {
    errors.push(rollupError("rollup_schema_invalid", "rollup batch schema_version must be 0", "schema_version"));
  }
  if (!Array.isArray(raw.candidates)) {
    errors.push(rollupError("rollup_shape_invalid", "rollup batch candidates must be an array", "candidates"));
    return { ok: false, errors };
  }
  if (raw.candidates.length === 0) {
    errors.push(rollupError("rollup_empty", "rollup batch must contain at least one candidate", "candidates"));
  }

  const candidateIds: string[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < raw.candidates.length; index++) {
    const candidateInput = raw.candidates[index];
    const id = isObject(candidateInput) && typeof candidateInput.id === "string" && candidateInput.id.trim().length > 0
      ? candidateInput.id
      : undefined;
    if (id === undefined) {
      errors.push(rollupError("rollup_candidate_id_invalid", `candidates[${index}] must have a non-empty string id`, `candidates[${index}].id`));
      continue;
    }
    if (seenIds.has(id)) {
      errors.push(rollupError("rollup_candidate_duplicate", `candidate id ${id} appears more than once in the batch`, `candidates[${index}].id`));
      continue;
    }
    seenIds.add(id);
    candidateIds.push(id);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { candidates: raw.candidates, candidateIds } };
}

/** For creates `mutation.beforeText` is already `null`, so this uniformly diffs `""` -> `afterText` for creates and `beforeText` -> `afterText` for updates. */
function reviewMutation(mutation: PlannedMutation): RollupReviewMutation {
  const diffText = renderUnifiedDiff(mutation.recordId, mutation.beforeText ?? "", mutation.afterText);
  return { action: mutation.action, record_id: mutation.recordId, diff: diffText.split("\n") };
}

function reviewItem(index: number, item: PreparedItem): RollupReviewItem {
  return {
    index,
    candidate_id: item.candidateId,
    plan_hash: item.proposal.plan_hash,
    classification: item.proposal.plan.classification,
    disposition: item.proposal.plan.disposition,
    summary: item.proposal.plan.summary,
    mutations: item.proposal.plan.mutations.map(reviewMutation),
  };
}

const RANK: Record<RollupClassification, number> = {
  "no-change": 0,
  additive: 1,
  "non-additive": 2,
};

function rollupHash(items: readonly PreparedItem[]): string {
  const identity = {
    schema_version: 0,
    items: items.map((item) => ({
      candidate_id: item.candidateId,
      plan_hash: item.proposal.plan_hash,
    })),
  };
  return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

/**
 * Privately prepares the ordered batch: validates the wrapper, then
 * reconciles each candidate through the real per-candidate transaction in
 * order, stopping at the first non-proposal outcome. Returns both the
 * public preview and the ordered internal proposals the approval pass
 * applies.
 */
async function prepareKnowledgeRollup(input: {
  binding: ActiveSpace;
  batchInput: unknown;
  pack: KnowledgePack;
  spawnFn?: SpawnFn;
}): Promise<PreparedRollup | RollupPreparationFailure> {
  const validated = validateRollupInput(input.batchInput);
  if (!validated.ok) return { schema_version: 0, status: "invalid", errors: validated.errors };

  const prepared: PreparedItem[] = [];
  for (let index = 0; index < validated.value.candidates.length; index++) {
    const candidateId = requireDefined(validated.value.candidateIds[index], `rollup candidate id missing for index ${index}`);
    const outcome: ReconcileOutcome = await reconcileKnowledgeTransaction({
      binding: input.binding,
      candidateInput: validated.value.candidates[index],
      pack: input.pack,
      ...(input.spawnFn === undefined ? {} : { spawnFn: input.spawnFn }),
    });
    if (outcome.status !== "proposal") {
      return {
        schema_version: 0,
        status: outcome.status === "retrieval_failed" ? "retrieval_failed" : "invalid",
        failed_index: index,
        failed_candidate_id: candidateId,
        errors: outcome.errors.map(sanitizeRollupError),
      };
    }
    prepared.push({ candidateId, proposal: outcome.proposal });
  }

  const items = prepared.map((item, index) => reviewItem(index, item));
  const classification = items.reduce<RollupClassification>(
    (worst, item) => (RANK[item.classification] > RANK[worst] ? item.classification : worst),
    "no-change",
  );
  return {
    preview: {
      schema_version: 0,
      status: "preview",
      rollup_hash: rollupHash(prepared),
      classification,
      approval_required: classification === "non-additive",
      items,
    },
    items: prepared,
  };
}

export async function previewKnowledgeRollup(input: {
  binding: ActiveSpace;
  batchInput: unknown;
  pack: KnowledgePack;
  spawnFn?: SpawnFn;
}): Promise<KnowledgeRollupPreview | RollupPreparationFailure> {
  const result = await prepareKnowledgeRollup(input);
  return "preview" in result ? result.preview : result;
}

// ---------------------------------------------------------------------------
// Bound sequential approval with fail-stop application and one embedding
// pass. Consumes the private `prepareKnowledgeRollup` / `PreparedItem` and
// the existing per-candidate `applyKnowledgeProposal` rather than reinventing
// plan application, revalidation, or hashing.
// ---------------------------------------------------------------------------

/** One item `approveKnowledgeRollup`'s apply loop actually processed to
 * completion (`committed` or `no_change`) before any stop. Path-free and
 * text-free by construction, matching `RollupReviewMutation`'s own public
 * discipline. */
export type RollupApplyItem = {
  index: number;
  candidate_id: string;
  plan_hash: string;
  status: "committed" | "no_change";
  mutations: { action: "create" | "update"; record_id: string }[];
  refresh: RefreshReport;
};

/** A sanitized reason a rollup approval fail-stopped: every `KnowledgeError`
 * is rewritten through `sanitizeRollupError`, and no variant carries a
 * filesystem path except `recovery_required`'s `recovery.paths` — the one
 * documented exception, since recovery is impossible without the affected
 * paths (the same operator-only exception the underlying transaction
 * already exposes). */
export type RollupStopCause = {
  status: Exclude<ApplyKnowledgeOutcome["status"], "committed" | "no_change">;
  plan_hash?: string;
  expected_plan_hash?: string;
  actual_plan_hash?: string;
  errors?: KnowledgeError[];
  reason?: string;
  refresh: RefreshReport;
  recovery?: { required: true; paths: string[]; detail: string };
};

export type RollupEmbeddingReport =
  | EmbedReport
  | { attempted: false; state: "not-attempted"; detail: "rollup wrote no records" };

export type KnowledgeRollupApplyOutcome =
  | {
      schema_version: 0;
      status: "committed" | "no_change";
      rollup_hash: string;
      classification: RollupClassification;
      items: RollupApplyItem[];
      embedding: RollupEmbeddingReport;
    }
  | {
      schema_version: 0;
      status: "stopped";
      rollup_hash: string;
      committed_items: RollupApplyItem[];
      stopped_index: number;
      stopped_candidate_id: string;
      remaining_candidate_ids: string[];
      cause: RollupStopCause;
      embedding: RollupEmbeddingReport;
    }
  | { schema_version: 0; status: "stale_approval"; expected_rollup_hash: string; actual_rollup_hash: string; committed_items: []; embedding: RollupEmbeddingReport }
  | RollupPreparationFailure;

const ROLLUP_EMBEDDING_NOT_ATTEMPTED: RollupEmbeddingReport = {
  attempted: false,
  state: "not-attempted",
  detail: "rollup wrote no records",
};

/** `embedBoundCollection`'s `EmbedReport.detail` can carry qmd's raw
 * stdout/stderr verbatim, which may include an absolute path (for example
 * `binding.recordsRoot`, echoed back by qmd itself). Mirrors
 * `sanitizeRollupError`'s discipline: the free-text detail is replaced with
 * a fixed string derived only from the already-public `state`, never
 * passed through unmodified. */
function sanitizeEmbeddingReport(report: EmbedReport): EmbedReport {
  return {
    attempted: report.attempted,
    state: report.state,
    detail: `rollup embedding reported state: ${report.state}`,
  };
}

/** `refreshQmdCollection`'s `RefreshReport.detail` can carry qmd's raw
 * stdout/stderr verbatim, which may include an absolute path (for example
 * `binding.recordsRoot`, echoed back by qmd itself). Mirrors
 * `sanitizeEmbeddingReport`'s discipline: the free-text detail is replaced
 * with a fixed string derived only from the already-public `state`, never
 * passed through unmodified. */
function sanitizeRefreshReport(report: RefreshReport): RefreshReport {
  return { ...report, detail: `rollup refresh reported state: ${report.state}` };
}

/** The apply loop's one shared embedding call site: never called from
 * inside the loop, and only if at least one item literally committed a
 * write (a `no_change` item alone never embeds). */
async function boundaryEmbedding(binding: ActiveSpace, spawnFn: SpawnFn | undefined, committedCount: number): Promise<RollupEmbeddingReport> {
  if (committedCount === 0) return ROLLUP_EMBEDDING_NOT_ATTEMPTED;
  return sanitizeEmbeddingReport(await embedBoundCollection(binding, spawnFn));
}

function reviewApplyItem(
  index: number,
  item: PreparedItem,
  outcome: Extract<ApplyKnowledgeOutcome, { status: "committed" | "no_change" }>,
): RollupApplyItem {
  return {
    index,
    candidate_id: item.candidateId,
    plan_hash: outcome.plan_hash,
    status: outcome.status,
    mutations: outcome.mutations.map((mutation) => ({ action: mutation.action, record_id: mutation.recordId })),
    refresh: sanitizeRefreshReport(outcome.refresh),
  };
}

/** `outcome` must never be `committed`/`no_change` — those are the only two
 * statuses the apply loop continues past instead of stopping on. */
function toStopCause(outcome: ApplyKnowledgeOutcome): RollupStopCause {
  switch (outcome.status) {
    case "invalid":
      return { status: "invalid", errors: outcome.errors.map(sanitizeRollupError), refresh: outcome.refresh };
    case "stale_approval":
      return {
        status: "stale_approval",
        expected_plan_hash: outcome.expected_plan_hash,
        actual_plan_hash: outcome.actual_plan_hash,
        reason: outcome.reason,
        refresh: outcome.refresh,
      };
    case "rejected":
      return { status: "rejected", plan_hash: outcome.plan_hash, refresh: outcome.refresh };
    case "approval_required":
      return { status: "approval_required", plan_hash: outcome.plan_hash, refresh: outcome.refresh };
    case "lock_conflict":
    case "lock_owner_unverifiable":
      return { status: outcome.status, errors: outcome.errors.map(sanitizeRollupError), refresh: outcome.refresh };
    case "recovery_required":
      return { status: "recovery_required", plan_hash: outcome.plan_hash, recovery: outcome.recovery, refresh: outcome.refresh };
    case "committed":
    case "no_change":
      throw new Error(`internal invariant violated: toStopCause called with a continuable outcome status ${outcome.status}`);
  }
}

/**
 * Re-runs batch preparation against the CURRENT on-disk state — never a
 * stored proposal from an earlier preview — and refuses the whole batch
 * before any write if the freshly rebuilt `rollup_hash` no longer matches
 * what the caller approved. Once past that check, applies each item's
 * freshly rebuilt proposal in order via the existing `applyKnowledgeProposal`,
 * bound to that item's own current plan hash. The first outcome that is
 * neither `committed` nor `no_change` stops the batch: earlier commits are
 * left in place (no cross-candidate rollback) and every untried candidate
 * id is reported so the caller knows what still needs a decision.
 *
 * `embedBoundCollection` is called at most once, after the loop exits
 * (whether by finishing or by stopping), and only if at least one item
 * actually committed — never inside the loop, and never for an all-`no_change`
 * or pre-write-refused batch that wrote nothing.
 */
export async function approveKnowledgeRollup(input: {
  binding: ActiveSpace;
  batchInput: unknown;
  expectedRollupHash: string;
  pack: KnowledgePack;
  spawnFn?: SpawnFn;
}): Promise<KnowledgeRollupApplyOutcome> {
  const prepared = await prepareKnowledgeRollup(input);
  if (!("items" in prepared)) return prepared;

  if (prepared.preview.rollup_hash !== input.expectedRollupHash) {
    return {
      schema_version: 0,
      status: "stale_approval",
      expected_rollup_hash: input.expectedRollupHash,
      actual_rollup_hash: prepared.preview.rollup_hash,
      committed_items: [],
      embedding: ROLLUP_EMBEDDING_NOT_ATTEMPTED,
    };
  }

  const items: RollupApplyItem[] = [];
  let committedCount = 0;
  for (let index = 0; index < prepared.items.length; index++) {
    const item = requireDefined(prepared.items[index], `rollup approval item missing for index ${index}`);
    const outcome = await applyKnowledgeProposal({
      binding: input.binding,
      proposal: item.proposal,
      decision: "approve",
      expectedPlanHash: item.proposal.plan_hash,
      pack: input.pack,
      ...(input.spawnFn === undefined ? {} : { spawnFn: input.spawnFn }),
    });
    if (outcome.status === "committed" || outcome.status === "no_change") {
      if (outcome.status === "committed") committedCount++;
      items.push(reviewApplyItem(index, item, outcome));
      continue;
    }

    return {
      schema_version: 0,
      status: "stopped",
      rollup_hash: prepared.preview.rollup_hash,
      committed_items: items,
      stopped_index: index,
      stopped_candidate_id: item.candidateId,
      cause: toStopCause(outcome),
      remaining_candidate_ids: prepared.items.slice(index + 1).map((remaining) => remaining.candidateId),
      embedding: await boundaryEmbedding(input.binding, input.spawnFn, committedCount),
    };
  }

  return {
    schema_version: 0,
    status: committedCount > 0 ? "committed" : "no_change",
    rollup_hash: prepared.preview.rollup_hash,
    classification: prepared.preview.classification,
    items,
    embedding: await boundaryEmbedding(input.binding, input.spawnFn, committedCount),
  };
}
