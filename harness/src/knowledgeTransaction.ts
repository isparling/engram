import { lstat, readFile, realpath, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { atomicWriteFile, AtomicWriteDirectorySyncError } from "./atomicWrite.ts";
import { canonicalJson, hashKnowledgeText, parseKnowledgeRecord, serializeKnowledgeRecord } from "./knowledgeRecord.ts";
import { validateKnowledgeEnvelope } from "./knowledgeValidation.ts";
import { retrieveRelatedRecords, type RetrievalReceipt } from "./knowledgeRetrieval.ts";
import { acquireTransactionLock, transactionLockDirectory, type TransactionLock, type TransactionLockHooks } from "./transactionLock.ts";
import { REFRESH_NOT_ATTEMPTED, refreshQmdCollection, type AttemptedRefreshReport, type RefreshReport, type SpawnFn } from "./qmdRunner.ts";
import { resolveRecordPath } from "./spaceBinding.ts";
import type { ActiveSpace } from "./spaceRegistry.ts";
import { KNOWLEDGE_DISPOSITIONS } from "./knowledgeTypes.ts";
import type {
  KnowledgeDisposition,
  KnowledgeEnvelope,
  KnowledgeError,
  KnowledgePack,
  KnowledgeRecord,
  KnowledgeResult,
  PackMutation,
  PackReconciliation,
} from "./knowledgeTypes.ts";

export { transactionLockDirectory } from "./transactionLock.ts";

export type CandidateSubmissionOutcome =
  | { schema_version: 0; status: "submitted"; candidate: KnowledgeEnvelope }
  | { schema_version: 0; status: "invalid"; errors: KnowledgeError[] };

export type PlannedMutation = {
  recordId: string;
  action: "create" | "update";
  path: string;
  beforeText: string | null;
  beforeHash: string | null;
  afterText: string;
  after: KnowledgeRecord;
};

export type AuthoritativeInput = {
  recordId: string;
  path: string;
  beforeText: string;
  beforeHash: string;
};

export type KnowledgeMutationPlan = {
  classification: "additive" | "non-additive" | "no-change";
  disposition: KnowledgeDisposition;
  summary: string;
  mutations: PlannedMutation[];
  authoritativeInputs: AuthoritativeInput[];
  protectedPaths: string[];
  bindingFingerprint: string;
  candidateFingerprint: string;
};

export type KnowledgeProposal = {
  schema_version: 0;
  candidate: KnowledgeEnvelope;
  retrieval: RetrievalReceipt;
  plan: KnowledgeMutationPlan;
  plan_hash: string;
};

export type ReconcileOutcome =
  | { schema_version: 0; status: "invalid"; errors: KnowledgeError[]; retrieval: { attempted: false } }
  | { schema_version: 0; status: "retrieval_failed"; errors: KnowledgeError[]; retrieval: RetrievalReceipt }
  | { schema_version: 0; status: "proposal"; proposal: KnowledgeProposal };

export type WriteKnowledgeRecordFn = (path: string, content: string) => Promise<void>;

export type ApplyKnowledgeInput = {
  binding: ActiveSpace;
  proposal: KnowledgeProposal;
  decision: "approve" | "reject";
  expectedPlanHash?: string;
  candidateInput?: unknown;
  pack: KnowledgePack;
  writeRecord?: WriteKnowledgeRecordFn;
  spawnFn?: SpawnFn;
  transactionLockHooks?: TransactionLockHooks;
};

export type ApplyKnowledgeOutcome =
  | { schema_version: 0; status: "invalid"; errors: KnowledgeError[]; refresh: RefreshReport }
  | { schema_version: 0; status: "stale_approval"; expected_plan_hash: string; actual_plan_hash: string; reason: string; refresh: RefreshReport }
  | { schema_version: 0; status: "rejected"; plan_hash: string; mutations: PlannedMutation[]; refresh: RefreshReport; lock: { state: "acquired" | "recovered" } }
  | { schema_version: 0; status: "no_change"; plan_hash: string; mutations: []; refresh: RefreshReport; lock: { state: "acquired" | "recovered" } }
  | { schema_version: 0; status: "committed"; plan_hash: string; mutations: PlannedMutation[]; refresh: AttemptedRefreshReport; lock: { state: "acquired" | "recovered" } }
  | { schema_version: 0; status: "approval_required"; plan_hash: string; mutations: PlannedMutation[]; refresh: RefreshReport }
  | { schema_version: 0; status: "lock_conflict" | "lock_owner_unverifiable"; errors: KnowledgeError[]; refresh: RefreshReport }
  | { schema_version: 0; status: "recovery_required"; plan_hash: string; mutations: PlannedMutation[]; recovery: { required: true; paths: string[]; detail: string }; refresh: RefreshReport };

function invalidOutcome(errors: KnowledgeError[]): ReconcileOutcome {
  return { schema_version: 0, status: "invalid", errors, retrieval: { attempted: false } };
}

function transactionError(code: string, message: string, field?: string): KnowledgeError {
  return field === undefined
    ? { kind: "transaction", code, message }
    : { kind: "transaction", code, field, message };
}

function validationError(code: string, message: string, field?: string): KnowledgeError {
  return field === undefined
    ? { kind: "validation", code, message }
    : { kind: "validation", code, field, message };
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith(".." + sep) && pathFromRoot !== ".." && !pathFromRoot.startsWith(sep));
}

function bindingFingerprint(binding: ActiveSpace): string {
  return hashKnowledgeText(canonicalJson({
    spaceId: binding.spaceId,
    spaceRoot: binding.spaceRoot,
    recordsRoot: binding.recordsRoot,
    manifestPath: binding.manifestPath,
    qmdConfigDir: binding.qmdConfigDir,
    qmdCacheHome: binding.qmdCacheHome,
    qmdCollectionName: binding.qmdCollectionName,
    sessionsDir: binding.sessionsDir,
    readRoots: [...binding.readRoots].sort(),
    writeRoots: [...binding.writeRoots].sort(),
    allowedModels: [...binding.allowedModels].sort(),
    credentialEnv: [...binding.credentialEnv].sort(),
    knowledgeSchemaVersion: binding.knowledgeSchemaVersion,
    packs: binding.packs.map((pack) => ({ id: pack.id, version: pack.version })).sort((left, right) => left.id.localeCompare(right.id)),
  }));
}

function installedPack(binding: ActiveSpace, pack: KnowledgePack, candidate: KnowledgeEnvelope): KnowledgeResult<void> {
  const installed = binding.packs.some((item) => item.id === candidate.pack.id && item.version === candidate.pack.version);
  if (!installed) return { ok: false, errors: [validationError("pack_not_installed", `pack ${candidate.pack.id}@${candidate.pack.version} is not installed in the active binding`, "pack")] };
  if (candidate.pack.id !== pack.id || candidate.pack.version !== pack.version) {
    return { ok: false, errors: [validationError("pack_mismatch", "candidate pack and loaded pack do not match", "pack")] };
  }
  return { ok: true, value: undefined };
}

function isKnowledgeDisposition(value: unknown): value is KnowledgeDisposition {
  return KNOWLEDGE_DISPOSITIONS.some((item) => item === value);
}

function prepareCandidate(binding: ActiveSpace, input: unknown, pack: KnowledgePack): KnowledgeResult<KnowledgeEnvelope> {
  const parsed = validateKnowledgeEnvelope(input);
  if (!parsed.ok) return parsed;
  if (parsed.value.scope.space !== binding.spaceId) {
    return { ok: false, errors: [validationError("scope_space_mismatch", `scope.space must equal the active space ${binding.spaceId}`, "scope.space")] };
  }
  const packResult = installedPack(binding, pack, parsed.value);
  if (!packResult.ok) return packResult;
  let packValidation: KnowledgeResult<void>;
  try {
    packValidation = pack.validateEnvelope(parsed.value);
  } catch (error) {
    return { ok: false, errors: [validationError("pack_validation_failed", `pack validation failed: ${error instanceof Error ? error.message : String(error)}`, "pack")] };
  }
  if (!packValidation.ok) return packValidation;
  return parsed;
}

function rawEnvelope(candidate: KnowledgeEnvelope): Record<string, unknown> {
  return {
    id: candidate.id,
    kind: candidate.kind,
    status: candidate.status,
    statement: candidate.statement,
    details: candidate.details,
    scope: candidate.scope,
    pack: candidate.pack,
    sources: candidate.sources,
    session: candidate.session,
    submitted_at: candidate.submittedAt,
    disposition: candidate.disposition,
  };
}

export function submitKnowledgeCandidate(input: { binding: ActiveSpace; candidateInput: unknown; pack: KnowledgePack }): CandidateSubmissionOutcome {
  const candidateResult = prepareCandidate(input.binding, input.candidateInput, input.pack);
  if (!candidateResult.ok) return { schema_version: 0, status: "invalid", errors: candidateResult.errors };
  return { schema_version: 0, status: "submitted", candidate: candidateResult.value };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isObject(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function readCurrent(binding: ActiveSpace, path: string): Promise<KnowledgeResult<{ bytes: Buffer; text: string; record: KnowledgeRecord } | null>> {
  if (!pathWithin(binding.recordsRoot, path)) {
    return { ok: false, errors: [transactionError("path_escape", `authoritative record path is outside the active records root: ${path}`, path)] };
  }

  let linkStatus;
  try {
    linkStatus = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, value: null };
    return { ok: false, errors: [transactionError("record_read_failed", `failed to inspect planned path ${path}: ${error instanceof Error ? error.message : String(error)}`, path)] };
  }
  if (!linkStatus.isFile() && !linkStatus.isSymbolicLink()) {
    return { ok: false, errors: [transactionError("record_shape_invalid", `authoritative record path is not a regular file: ${path}`, path)] };
  }

  let recordsRoot: string;
  try {
    recordsRoot = await realpath(binding.recordsRoot);
  } catch (error) {
    return { ok: false, errors: [transactionError("path_escape", `active records root could not be resolved: ${error instanceof Error ? error.message : String(error)}`, path)] };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(path);
  } catch (error) {
    return { ok: false, errors: [transactionError("path_escape", `authoritative record path could not be resolved safely: ${path}: ${error instanceof Error ? error.message : String(error)}`, path)] };
  }
  if (!pathWithin(recordsRoot, resolvedPath)) {
    return { ok: false, errors: [transactionError("path_escape", `authoritative record path escapes the active records root: ${path}`, path)] };
  }
  try {
    if (!(await stat(resolvedPath)).isFile()) {
      return { ok: false, errors: [transactionError("record_shape_invalid", `authoritative record path is not a regular file: ${path}`, path)] };
    }
  } catch (error) {
    return { ok: false, errors: [transactionError("record_read_failed", `failed to inspect authoritative record ${path}: ${error instanceof Error ? error.message : String(error)}`, path)] };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(resolvedPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: false, errors: [transactionError("record_read_failed", `authoritative record disappeared while it was being read: ${path}`, path)] };
    return { ok: false, errors: [transactionError("record_read_failed", `failed to read planned path ${path}: ${error instanceof Error ? error.message : String(error)}`, path)] };
  }
  const text = bytes.toString("utf8");
  const parsed = parseKnowledgeRecord(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors.map((item) => transactionError("record_invalid", `${path}: ${item.message}`, path)) };
  return { ok: true, value: { bytes, text, record: parsed.value } };
}

function recordBase(record: KnowledgeRecord): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    statement: record.statement,
    details: record.details,
    scope: record.scope,
    pack: record.pack,
    sources: record.sources,
    session: record.session,
    submittedAt: record.submittedAt,
    disposition: record.disposition,
  };
}

function arrayIsAppendOnly(before: string[], after: string[]): boolean {
  if (after.length < before.length) return false;
  for (let index = 0; index < before.length; index++) if (before[index] !== after[index]) return false;
  return true;
}

function mutationIsAdditive(before: KnowledgeRecord, after: KnowledgeRecord): boolean {
  if (canonicalJson(recordBase(before)) !== canonicalJson(recordBase(after))) return false;
  for (const key of ["supports", "contradicts", "refines", "supersedes"] as const) {
    if (!arrayIsAppendOnly(before.relationships[key], after.relationships[key])) return false;
  }
  if (before.history.length > after.history.length) return false;
  for (let index = 0; index < before.history.length; index++) {
    if (canonicalJson(before.history[index]) !== canonicalJson(after.history[index])) return false;
  }
  return true;
}

function preservesRecordTrace(before: KnowledgeRecord, after: KnowledgeRecord): boolean {
  for (const key of ["supports", "contradicts", "refines", "supersedes"] as const) {
    for (const relatedId of before.relationships[key]) {
      if (!after.relationships[key].includes(relatedId)) return false;
    }
  }
  for (const entry of before.history) {
    if (!after.history.some((candidate) => canonicalJson(candidate) === canonicalJson(entry))) return false;
  }
  return true;
}

function preservesRecordProvenance(before: KnowledgeRecord, after: KnowledgeRecord): boolean {
  return canonicalJson(before.sources) === canonicalJson(after.sources)
    && canonicalJson(before.session) === canonicalJson(after.session)
    && canonicalJson(before.scope) === canonicalJson(after.scope);
}

function stateTransitionAllowed(before: KnowledgeRecord, after: KnowledgeRecord): boolean {
  if (before.status === "retired" && after.status !== "retired") return false;
  if ((before.status === "active" || before.status === "contested") && after.status === "candidate") return false;
  return true;
}

function planHash(candidate: KnowledgeEnvelope, binding: ActiveSpace, plan: KnowledgeMutationPlan): string {
  return hashKnowledgeText(canonicalJson({
    candidate,
    bindingFingerprint: bindingFingerprint(binding),
    plan,
  }));
}

function planPath(binding: ActiveSpace, recordId: string): KnowledgeResult<string> {
  const resolved = resolveRecordPath(binding, recordId);
  if (!resolved.ok) return { ok: false, errors: resolved.errors.map((message) => transactionError("protected_path", message, "path")) };
  if (binding.writeRoots.length === 0 || !binding.writeRoots.some((root) => pathWithin(root, resolved.value))) {
    return { ok: false, errors: [transactionError("protected_path", `planned path is outside every active write root: ${resolved.value}`, "path")] };
  }
  if (!pathWithin(binding.spaceRoot, resolved.value)) {
    return { ok: false, errors: [transactionError("protected_path", `planned path is outside the active space root: ${resolved.value}`, "path")] };
  }
  return resolved;
}

function validatePackMutation(mutation: PackMutation, candidate: KnowledgeEnvelope, binding: ActiveSpace): KnowledgeResult<void> {
  if (mutation.action !== "create" && mutation.action !== "update") {
    return { ok: false, errors: [transactionError("mutation_action_invalid", `pack returned an unsupported mutation action for ${candidate.id}`, "plan.mutations")] };
  }
  if (mutation.record.scope.space !== binding.spaceId) {
    return { ok: false, errors: [transactionError("scope_space_mismatch", `pack mutation ${mutation.record.id} is outside the active space`, "scope.space")] };
  }
  if (mutation.record.pack.id !== candidate.pack.id || mutation.record.pack.version !== candidate.pack.version) {
    return { ok: false, errors: [transactionError("provenance_mismatch", `pack mutation ${mutation.record.id} changes pack provenance`, "pack")] };
  }
  try {
    const serialized = serializeKnowledgeRecord(mutation.record);
    const parsed = parseKnowledgeRecord(serialized);
    if (!parsed.ok) return { ok: false, errors: parsed.errors.map((item) => transactionError("pack_record_invalid", item.message, mutation.record.id)) };
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, errors: [transactionError("pack_record_invalid", `pack mutation ${mutation.record.id} could not be serialized: ${error instanceof Error ? error.message : String(error)}`, mutation.record.id)] };
  }
}

function validateReconciliation(reconciliation: PackReconciliation, candidate: KnowledgeEnvelope): KnowledgeResult<PackReconciliation> {
  if (!isKnowledgeDisposition(reconciliation.disposition) || reconciliation.disposition !== candidate.disposition) {
    return { ok: false, errors: [transactionError("disposition_mismatch", "pack reconciliation disposition must match the submitted envelope", "disposition")] };
  }
  if (typeof reconciliation.summary !== "string" || reconciliation.summary.trim().length === 0 || /[\r\n]/.test(reconciliation.summary)) {
    return { ok: false, errors: [transactionError("summary_invalid", "pack reconciliation summary must be a non-empty single-line string", "plan.summary")] };
  }
  if (!Array.isArray(reconciliation.mutations)) {
    return { ok: false, errors: [transactionError("mutations_invalid", "pack reconciliation mutations must be an array", "plan.mutations")] };
  }
  return { ok: true, value: reconciliation };
}

async function buildPlan(
  binding: ActiveSpace,
  candidate: KnowledgeEnvelope,
  reconciliation: PackReconciliation,
  relatedIds: Set<string>,
  authoritativeInputs: AuthoritativeInput[],
): Promise<KnowledgeResult<KnowledgeMutationPlan>> {
  const errors: KnowledgeError[] = [];
  const seen = new Set<string>();
  const mutations: PlannedMutation[] = [];
  for (const mutation of reconciliation.mutations) {
    if (seen.has(mutation.record.id)) {
      errors.push(transactionError("duplicate_mutation", `pack returned more than one mutation for ${mutation.record.id}`, "plan.mutations"));
      continue;
    }
    seen.add(mutation.record.id);
    const packMutation = validatePackMutation(mutation, candidate, binding);
    if (!packMutation.ok) {
      errors.push(...packMutation.errors);
      continue;
    }
    const path = planPath(binding, mutation.record.id);
    if (!path.ok) {
      errors.push(...path.errors);
      continue;
    }
    const current = await readCurrent(binding, path.value);
    if (!current.ok) {
      errors.push(...current.errors);
      continue;
    }
    if (mutation.action === "create") {
      if (current.value !== null) {
        errors.push(transactionError("create_target_exists", `pack requested creation of existing record ${mutation.record.id}`, mutation.record.id));
        continue;
      }
      mutations.push({ recordId: mutation.record.id, action: "create", path: path.value, beforeText: null, beforeHash: null, afterText: serializeKnowledgeRecord(mutation.record), after: mutation.record });
      continue;
    }
    if (!relatedIds.has(mutation.record.id)) {
      errors.push(transactionError("update_target_not_retrieved", `pack update target ${mutation.record.id} was not returned by active-space retrieval`, mutation.record.id));
      continue;
    }
    if (current.value === null) {
      errors.push(transactionError("update_target_missing", `pack requested update of missing record ${mutation.record.id}`, mutation.record.id));
      continue;
    }
    if (!preservesRecordTrace(current.value.record, mutation.record) || !preservesRecordProvenance(current.value.record, mutation.record)) {
      errors.push(transactionError("record_trace_loss", `pack update ${mutation.record.id} would delete or change existing relationships, history, sources, session, or scope`, mutation.record.id));
      continue;
    }
    if (!stateTransitionAllowed(current.value.record, mutation.record)) {
      errors.push(transactionError("state_transition_invalid", `pack update ${mutation.record.id} requests an invalid lifecycle transition`, mutation.record.id));
      continue;
    }
    mutations.push({
      recordId: mutation.record.id,
      action: "update",
      path: path.value,
      beforeText: current.value.text,
      beforeHash: hashBytes(current.value.bytes),
      afterText: serializeKnowledgeRecord(mutation.record),
      after: mutation.record,
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  const classification = mutations.length === 0
    ? "no-change"
    : "additive";
  let actualClassification: "additive" | "non-additive" | "no-change" = classification;
  for (const mutation of mutations) {
    if (mutation.action !== "create" && mutation.beforeText !== null) {
      const before = parseKnowledgeRecord(mutation.beforeText);
      if (!before.ok || !mutationIsAdditive(before.value, mutation.after)) actualClassification = "non-additive";
    }
  }
  const plan: KnowledgeMutationPlan = {
    classification: actualClassification,
    disposition: reconciliation.disposition,
    summary: reconciliation.summary,
    mutations,
    authoritativeInputs,
    protectedPaths: mutations.map((mutation) => mutation.path),
    bindingFingerprint: bindingFingerprint(binding),
    candidateFingerprint: hashKnowledgeText(canonicalJson(candidate)),
  };
  return { ok: true, value: plan };
}

export async function reconcileKnowledgeTransaction(input: {
  binding: ActiveSpace;
  candidateInput: unknown;
  pack: KnowledgePack;
  spawnFn?: SpawnFn;
  beforePlanBuild?: () => Promise<void>;
  // Test-only seam mirroring beforePlanBuild: fires after retrieval has read each
  // related record but before the authoritative comparison re-reads and validates
  // them against current disk state. Lets a test deterministically simulate a related
  // record changing underneath a transaction in that specific window, instead of
  // racing real filesystem I/O against JS's synchronous continuation.
  afterRetrieval?: () => Promise<void>;
}): Promise<ReconcileOutcome> {
  const candidateResult = prepareCandidate(input.binding, input.candidateInput, input.pack);
  if (!candidateResult.ok) return invalidOutcome(candidateResult.errors);
  const query = input.pack.relatedQuery(candidateResult.value);
  if (typeof query !== "string" || query.trim().length === 0 || /[\r\n]/.test(query)) {
    return invalidOutcome([validationError("query_invalid", "pack retrieval query must be a non-empty single-line string")]);
  }
  const retrieval = await retrieveRelatedRecords(input.binding, query, input.spawnFn);
  if (retrieval.kind === "failure") return { schema_version: 0, status: "retrieval_failed", errors: retrieval.errors, retrieval: retrieval.receipt };
  const relatedRecords = retrieval.kind === "hit" ? retrieval.records : [];
  if (input.afterRetrieval !== undefined) await input.afterRetrieval();
  const authoritativeInputs: AuthoritativeInput[] = [];
  const authoritativeErrors: KnowledgeError[] = [];
  for (const related of relatedRecords) {
    const path = planPath(input.binding, related.record.id);
    if (!path.ok) {
      authoritativeErrors.push(...path.errors);
      continue;
    }
    const current = await readCurrent(input.binding, path.value);
    if (!current.ok) {
      authoritativeErrors.push(...current.errors);
      continue;
    }
    if (current.value === null) {
      authoritativeErrors.push(transactionError("related_record_missing", `related record ${related.record.id} vanished before planning`, related.record.id));
      continue;
    }
    if (canonicalJson(current.value.record) !== canonicalJson(related.record)) {
      authoritativeErrors.push(transactionError("related_record_changed", `related record ${related.record.id} changed while the transaction was being planned`, related.record.id));
      continue;
    }
    authoritativeInputs.push({ recordId: related.record.id, path: path.value, beforeText: current.value.text, beforeHash: hashBytes(current.value.bytes) });
  }
  if (authoritativeErrors.length > 0) return invalidOutcome(authoritativeErrors);
  if (input.beforePlanBuild !== undefined) await input.beforePlanBuild();
  const related = relatedRecords.map((item) => item.record);
  let reconciliation: KnowledgeResult<PackReconciliation>;
  try {
    reconciliation = input.pack.reconcile({ candidate: candidateResult.value, related });
  } catch (error) {
    return invalidOutcome([transactionError("pack_reconcile_failed", `pack reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)]);
  }
  if (!reconciliation.ok) return invalidOutcome(reconciliation.errors);
  const checkedReconciliation = validateReconciliation(reconciliation.value, candidateResult.value);
  if (!checkedReconciliation.ok) return invalidOutcome(checkedReconciliation.errors);
  const planResult = await buildPlan(
    input.binding,
    candidateResult.value,
    checkedReconciliation.value,
    new Set(related.map((record) => record.id)),
    authoritativeInputs,
  );
  if (!planResult.ok) return invalidOutcome(planResult.errors);
  const proposal: KnowledgeProposal = {
    schema_version: 0,
    candidate: candidateResult.value,
    retrieval: retrieval.receipt,
    plan: planResult.value,
    plan_hash: planHash(candidateResult.value, input.binding, planResult.value),
  };
  return { schema_version: 0, status: "proposal", proposal };
}

async function currentMutationState(binding: ActiveSpace, mutation: PlannedMutation): Promise<KnowledgeResult<{ current: { bytes: Buffer; text: string; record: KnowledgeRecord } | null; stable: boolean }>> {
  const path = planPath(binding, mutation.recordId);
  if (!path.ok) return path;
  if (path.value !== mutation.path) return { ok: false, errors: [transactionError("protected_path", `plan path is not derived from the active binding: ${mutation.path}`, "path")] };
  const current = await readCurrent(binding, path.value);
  if (!current.ok) return current;
  const stable = mutation.action === "create"
    ? current.value === null
    : current.value !== null && mutation.beforeText === current.value.text && mutation.beforeHash === hashBytes(current.value.bytes);
  return { ok: true, value: { current: current.value, stable } };
}

async function currentAuthoritativeState(binding: ActiveSpace, input: AuthoritativeInput): Promise<KnowledgeResult<{ current: { bytes: Buffer; text: string; record: KnowledgeRecord } | null; stable: boolean }>> {
  const path = planPath(binding, input.recordId);
  if (!path.ok) return path;
  if (path.value !== input.path) return { ok: false, errors: [transactionError("protected_path", `authoritative input path is not derived from the active binding: ${input.path}`, "path")] };
  const current = await readCurrent(binding, path.value);
  if (!current.ok) return current;
  const stable = current.value !== null && input.beforeText === current.value.text && input.beforeHash === hashBytes(current.value.bytes);
  return { ok: true, value: { current: current.value, stable } };
}

async function revalidateProposal(input: ApplyKnowledgeInput, candidate: KnowledgeEnvelope): Promise<KnowledgeResult<{ actualPlanHash: string; stable: boolean }>> {
  const currentMutations: PlannedMutation[] = [];
  const currentInputs: AuthoritativeInput[] = [];
  let stable = input.proposal.plan.bindingFingerprint === bindingFingerprint(input.binding);
  if (input.proposal.plan.candidateFingerprint !== hashKnowledgeText(canonicalJson(candidate))) stable = false;
  for (const mutation of input.proposal.plan.mutations) {
    const currentResult = await currentMutationState(input.binding, mutation);
    if (!currentResult.ok) {
      if (input.proposal.plan.bindingFingerprint !== bindingFingerprint(input.binding) && currentResult.errors.some((error) => error.code === "protected_path")) {
        stable = false;
        currentMutations.push({ ...mutation, beforeText: null, beforeHash: null });
        continue;
      }
      return currentResult;
    }
    const current = currentResult.value.current;
    if (!currentResult.value.stable) stable = false;
    currentMutations.push({
      ...mutation,
      beforeText: current?.text ?? null,
      beforeHash: current === null ? null : hashBytes(current.bytes),
    });
  }
  for (const authoritativeInput of input.proposal.plan.authoritativeInputs) {
    const currentResult = await currentAuthoritativeState(input.binding, authoritativeInput);
    if (!currentResult.ok) {
      if (input.proposal.plan.bindingFingerprint !== bindingFingerprint(input.binding) && currentResult.errors.some((error) => error.code === "protected_path")) {
        stable = false;
        currentInputs.push({ ...authoritativeInput, beforeText: "", beforeHash: "" });
        continue;
      }
      return currentResult;
    }
    if (!currentResult.value.stable) stable = false;
    if (currentResult.value.current === null) currentInputs.push({ ...authoritativeInput, beforeText: "", beforeHash: "" });
    else currentInputs.push({ ...authoritativeInput, beforeText: currentResult.value.current.text, beforeHash: hashBytes(currentResult.value.current.bytes) });
  }
  const currentPlan: KnowledgeMutationPlan = { ...input.proposal.plan, mutations: currentMutations, authoritativeInputs: currentInputs, protectedPaths: currentMutations.map((mutation) => mutation.path) };
  const actualPlanHash = planHash(candidate, input.binding, currentPlan);
  if (actualPlanHash !== input.proposal.plan_hash) stable = false;
  return { ok: true, value: { actualPlanHash, stable } };
}

function lockOutcome(lock: KnowledgeResult<TransactionLock>): ApplyKnowledgeOutcome {
  const status = lock.ok ? "lock_conflict" : lock.errors[0]?.code === "lock_owner_unverifiable" ? "lock_owner_unverifiable" : "lock_conflict";
  return { schema_version: 0, status, errors: lock.ok ? [] : lock.errors, refresh: REFRESH_NOT_ATTEMPTED };
}

export async function applyKnowledgeProposal(input: ApplyKnowledgeInput): Promise<ApplyKnowledgeOutcome> {
  const candidateResult = prepareCandidate(input.binding, input.candidateInput ?? rawEnvelope(input.proposal.candidate), input.pack);
  let candidate: KnowledgeEnvelope;
  if (!candidateResult.ok) {
    // A previously valid proposal presented against another active space must
    // be reported as stale, not reclassified as a new invalid submission.
    // The proposal's original envelope remains an authoritative input for the
    // binding-mismatch check below; it can never be written under the new root.
    if (input.candidateInput === undefined && input.proposal.plan.bindingFingerprint !== bindingFingerprint(input.binding)) {
      candidate = input.proposal.candidate;
    } else {
      return { schema_version: 0, status: "invalid", errors: candidateResult.errors, refresh: REFRESH_NOT_ATTEMPTED };
    }
  } else {
    candidate = candidateResult.value;
  }
  const plan = input.proposal.plan;
  if (plan.classification === "non-additive" && input.expectedPlanHash === undefined) {
    return { schema_version: 0, status: "approval_required", plan_hash: input.proposal.plan_hash, mutations: plan.mutations, refresh: REFRESH_NOT_ATTEMPTED };
  }

  const lock = await acquireTransactionLock(input.binding, input.transactionLockHooks);
  if (!lock.ok) return lockOutcome(lock);
  const held = lock.value;
  try {
    const revalidated = await revalidateProposal(input, candidate);
    if (!revalidated.ok) return { schema_version: 0, status: "invalid", errors: revalidated.errors, refresh: REFRESH_NOT_ATTEMPTED };
    if (!revalidated.value.stable || input.expectedPlanHash !== undefined && input.expectedPlanHash !== revalidated.value.actualPlanHash) {
      return {
        schema_version: 0,
        status: "stale_approval",
        expected_plan_hash: input.expectedPlanHash ?? "",
        actual_plan_hash: revalidated.value.actualPlanHash,
        reason: "the candidate, binding, authoritative source record, related record, submission date, or complete mutation plan changed after preview",
        refresh: REFRESH_NOT_ATTEMPTED,
      };
    }
    if (plan.classification === "no-change") {
      return { schema_version: 0, status: "no_change", plan_hash: revalidated.value.actualPlanHash, mutations: [], refresh: REFRESH_NOT_ATTEMPTED, lock: { state: held.state } };
    }
    if (input.decision === "reject") {
      return { schema_version: 0, status: "rejected", plan_hash: revalidated.value.actualPlanHash, mutations: plan.mutations, refresh: REFRESH_NOT_ATTEMPTED, lock: { state: held.state } };
    }

    const writeRecord = input.writeRecord ?? atomicWriteFile;
    const writtenPaths: string[] = [];
    try {
      for (const mutation of plan.mutations) {
        await writeRecord(mutation.path, mutation.afterText);
        writtenPaths.push(mutation.path);
      }
    } catch (error) {
      const isAmbiguous = error instanceof AtomicWriteDirectorySyncError;
      const rollbackErrors: string[] = [];
      if (!isAmbiguous) {
        for (const mutation of plan.mutations) {
          try {
            if (mutation.beforeText === null) await rm(mutation.path, { force: true });
            else await atomicWriteFile(mutation.path, mutation.beforeText);
          } catch (rollbackError) {
            rollbackErrors.push(`${mutation.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
        }
      }
      const detail = isAmbiguous
        ? `post-rename ambiguity at ${writtenPaths.join(", ") || plan.mutations[0]?.path || transactionLockDirectory(input.binding)}; exact recovery is required before retrying`
        : rollbackErrors.length === 0
          ? `durable Markdown transaction failed before completion and all planned paths were restored: ${error instanceof Error ? error.message : String(error)}`
          : `durable Markdown transaction failed and rollback also failed: ${error instanceof Error ? error.message : String(error)}; exact recovery is required for ${rollbackErrors.join("; ")}`;
      return {
        schema_version: 0,
        status: "recovery_required",
        plan_hash: revalidated.value.actualPlanHash,
        mutations: plan.mutations,
        recovery: { required: true, paths: plan.mutations.map((mutation) => mutation.path), detail },
        refresh: REFRESH_NOT_ATTEMPTED,
      };
    }
    const refresh = await refreshQmdCollection(input.binding, input.spawnFn);
    return { schema_version: 0, status: "committed", plan_hash: revalidated.value.actualPlanHash, mutations: plan.mutations, refresh, lock: { state: held.state } };
  } finally {
    await held.release();
  }
}
