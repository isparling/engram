import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep, join } from "node:path";
import { type GuardedRetrievalOutcome, type GuardedRetrievalRecord } from "./guardedRetrieval.ts";
import { guardedEnumerateInActiveSpace, guardedRetrieveInActiveSpace } from "./guardedRetrievalInternal.ts";
import type { SpawnFn } from "./qmdRunner.ts";
import { resolveActiveSpace, type ActiveSpace } from "./spaceRegistry.ts";
import type { EnvLike } from "./types.ts";
import type {
  AudienceDefinition,
  DeliveryDefinition,
  KnowledgeError,
  KnowledgeRecord,
  PresentationDraft,
  PresentationPack,
  SemanticProjection,
  ViewDefinition,
} from "./knowledgeTypes.ts";
import type { RetrievalReceipt } from "./knowledgeRetrieval.ts";
import { canonicalJson } from "./knowledgeRecord.ts";
import { deepFreeze } from "./deepFreeze.ts";

export type { PresentationPack } from "./knowledgeTypes.ts";

export type PresentationRequest = {
  viewId: string;
  audienceId: string;
  deliveryId: string;
  model: string;
  pack: PresentationPack;
  query?: string;
  generatedAt?: string;
};

export type PresentationReceipt = {
  schemaVersion: 0;
  presentationId: string;
  activeSpace: string;
  viewId: string;
  viewVersion: number;
  audienceId: string;
  audienceVersion: number;
  deliveryId: string;
  deliveryVersion: number;
  sourceRecordIds: string[];
  sourceReferences: Array<{ recordId: string; sourceUri: string; relativePath: string }>;
  retrievalReceipt: RetrievalReceipt;
  pack: { id: string; version: string };
  model: string;
  recommendationIds: string[];
  generatedAt: string;
  retention?: { artifactReference: string; receiptReference: string };
};

export type RetainedPresentation = {
  artifactPath: string;
  receiptPath: string;
};

export type PresentationSuccess = {
  schema_version: 0;
  status: "presented";
  content: string;
  receipt: PresentationReceipt;
  retained?: RetainedPresentation;
};

export type PresentationFailure = {
  schema_version: 0;
  status: "failed";
  errors: KnowledgeError[];
  retrieval?: RetrievalReceipt;
};

export type PresentationOutcome = PresentationSuccess | PresentationFailure;

export type PresentationOptions = {
  env?: EnvLike;
  spawnFn?: SpawnFn;
  writeRetentionFile?: (path: string, content: string) => Promise<void>;
};

function presentationError(code: string, message: string, field?: string, kind: KnowledgeError["kind"] = "presentation"): KnowledgeError {
  return field === undefined
    ? { kind, code, message }
    : { kind, code, field, message };
}

function failure(errors: KnowledgeError[], retrieval?: RetrievalReceipt): PresentationFailure {
  return {
    schema_version: 0,
    status: "failed",
    errors,
    ...(retrieval === undefined ? {} : { retrieval }),
  };
}

function isInstalled(active: ActiveSpace, pack: PresentationPack): boolean {
  return active.packs.some((candidate) => candidate.id === pack.id && candidate.version === pack.version);
}

function findView(pack: PresentationPack, id: string): ViewDefinition | undefined {
  return pack.views.find((candidate) => candidate.id === id);
}

function findAudience(pack: PresentationPack, id: string): AudienceDefinition | undefined {
  return pack.audiences.find((candidate) => candidate.id === id);
}

function findDelivery(pack: PresentationPack, id: string): DeliveryDefinition | undefined {
  return pack.deliveries.find((candidate) => candidate.id === id);
}

function textErrors(value: unknown, field: string, invalidCode = "text_type_invalid"): KnowledgeError[] {
  if (typeof value !== "string") return [presentationError(invalidCode, `${field} must be a string`, field)];
  if (value.trim().length === 0) return [presentationError("text_empty", `${field} must not be empty`, field)];
  if (value.includes("\n") || value.includes("\r")) return [presentationError("text_multiline", `${field} must be a single line`, field)];
  return [];
}

function listErrors(values: unknown, field: string, invalidCode = "text_type_invalid"): KnowledgeError[] {
  if (!Array.isArray(values)) return [presentationError(invalidCode, `${field} must be an array of strings`, field)];
  const errors: KnowledgeError[] = [];
  for (const value of values) errors.push(...textErrors(value, field, invalidCode));
  return errors;
}

function validateProjection(projection: SemanticProjection, records: readonly GuardedRetrievalRecord[]): KnowledgeError[] {
  const errors: KnowledgeError[] = [
    ...textErrors(projection.title, "view.title", "view_projection_invalid"),
    ...textErrors(projection.summary, "view.summary", "view_projection_invalid"),
    ...listErrors(projection.facts, "view.facts", "view_projection_invalid"),
    ...listErrors(projection.requiredFacts, "view.requiredFacts", "view_projection_invalid"),
    ...listErrors(projection.uncertainty, "view.uncertainty", "view_projection_invalid"),
    ...listErrors(projection.actions, "view.actions", "view_projection_invalid"),
    ...listErrors(projection.recommendationIds, "view.recommendationIds", "view_projection_invalid"),
  ];
  for (const fact of projection.requiredFacts) {
    if (!projection.facts.includes(fact)) errors.push(presentationError("required_fact_missing", "view required facts must be included in the view facts"));
  }
  errors.push(...validateRecommendationIds(records, projection.recommendationIds));
  return errors;
}

function validateDraft(draft: PresentationDraft): KnowledgeError[] {
  return [
    ...textErrors(draft.title, "audience.title", "audience_adaptation_invalid"),
    ...textErrors(draft.summary, "audience.summary", "audience_adaptation_invalid"),
    ...listErrors(draft.facts, "audience.facts", "audience_adaptation_invalid"),
    ...listErrors(draft.uncertainty, "audience.uncertainty", "audience_adaptation_invalid"),
    ...listErrors(draft.actions, "audience.actions", "audience_adaptation_invalid"),
    ...listErrors(draft.recommendationIds, "audience.recommendationIds", "audience_adaptation_invalid"),
  ];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function subsetOf(values: readonly string[], allowed: readonly string[]): boolean {
  return values.every((value) => allowed.includes(value));
}

function renderContent(draft: PresentationDraft, delivery: DeliveryDefinition): string {
  if (delivery.format === "json") {
    return JSON.stringify({
      title: draft.title,
      summary: draft.summary,
      facts: draft.facts,
      uncertainty: draft.uncertainty,
      actions: draft.actions,
    }, null, 2) + "\n";
  }
  if (delivery.format === "plain") {
    return [
      draft.title,
      draft.summary,
      `Facts: ${draft.facts.join("; ")}`,
      `Uncertainty: ${draft.uncertainty.join("; ")}`,
      `Actions: ${draft.actions.length === 0 ? "None recorded." : draft.actions.join("; ")}`,
      "",
    ].join("\n");
  }
  return [
    `# ${draft.title}`,
    "",
    draft.summary,
    "",
    "## Facts",
    ...draft.facts.map((fact) => `- ${fact}`),
    "",
    "## Uncertainty",
    ...draft.uncertainty.map((item) => `- ${item}`),
    "",
    "## Actions",
    ...(draft.actions.length === 0 ? ["- None recorded."] : draft.actions.map((action) => `- ${action}`)),
    "",
  ].join("\n");
}

function wordCount(content: string): number {
  const trimmed = content.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function pathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !pathFromRoot.startsWith(sep));
}

// Pack callbacks are handed configuration and hand back a draft. Both cross the
// boundary as live object references, so every guard that reads them must read
// a copy taken before the callback ran, not the object the callback still holds.
// Freezing alone is not enough: a frozen object with accessor properties still
// answers differently on each read, and freezing the caller's object does not
// stop it substituting a different one. These take one value per field, once.
//
// Without this, `renderPresentation` evaluated the retention boundary before
// `adapt` and the word limit after it, so an adapter that flipped `retain` and
// raised `maxWords` reached retention with the write-boundary check never
// having run.

function snapshotDelivery(delivery: DeliveryDefinition): DeliveryDefinition {
  return Object.freeze({
    id: delivery.id,
    version: delivery.version,
    format: delivery.format,
    maxWords: delivery.maxWords,
    retain: delivery.retain,
  });
}

function snapshotProjection(projection: SemanticProjection): SemanticProjection {
  return deepFreeze({
    title: projection.title,
    summary: projection.summary,
    facts: [...projection.facts],
    requiredFacts: [...projection.requiredFacts],
    uncertainty: [...projection.uncertainty],
    actions: [...projection.actions],
    recommendationIds: [...projection.recommendationIds],
  });
}

function snapshotDraft(draft: PresentationDraft): PresentationDraft {
  return deepFreeze({
    title: draft.title,
    summary: draft.summary,
    facts: [...draft.facts],
    uncertainty: [...draft.uncertainty],
    actions: [...draft.actions],
    recommendationIds: [...draft.recommendationIds],
  });
}

/**
 * Resolve `path` through any symlinks on the part of it that exists, keeping
 * the not-yet-created tail. `retain` creates its own root, so a plain realpath
 * fails on first use and a plain `resolve` follows nothing — and a symlink at
 * `<spaceRoot>/.engram-presentations` is exactly how a retained presentation
 * ends up inside the authoritative records root. Every other containment check
 * in this harness resolves; this one must too.
 */
async function resolveIntendedPath(path: string): Promise<string> {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const existing = await realpath(current);
      return tail.length === 0 ? existing : join(existing, ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function retentionPaths(active: ActiveSpace, presentationId: string): { root: string; directory: string; artifact: string; receipt: string; artifactReference: string; receiptReference: string } {
  const root = resolve(active.spaceRoot, ".engram-presentations");
  const directory = join(root, presentationId);
  return {
    root,
    directory,
    artifact: join(directory, "presentation.md"),
    receipt: join(directory, "receipt.json"),
    artifactReference: `.engram-presentations/${presentationId}/presentation.md`,
    receiptReference: `.engram-presentations/${presentationId}/receipt.json`,
  };
}

type RetentionBoundary =
  | { ok: true; resolvedRoot: string }
  | { ok: false; error: KnowledgeError };

/**
 * Decide whether this space may retain a presentation at all, against the
 * paths that will actually be written rather than the paths as written down.
 * Returns the resolved root so `retain` can confirm the directory it creates
 * is still the one that was authorized.
 */
async function retentionBoundary(active: ActiveSpace, delivery: DeliveryDefinition): Promise<RetentionBoundary> {
  const declaredRoot = retentionPaths(active, "placeholder").root;
  const resolvedRoot = await resolveIntendedPath(declaredRoot);
  const recordsRoot = await resolveIntendedPath(active.recordsRoot);
  const where = `${declaredRoot} resolves to ${resolvedRoot}`;
  if (pathWithin(recordsRoot, resolvedRoot) || pathWithin(resolvedRoot, recordsRoot)) {
    return {
      ok: false,
      error: presentationError(
        "artifact_root_not_segregated",
        `presentation retention root must be structurally outside the records root: ${where}`,
        "delivery",
        "artifact",
      ),
    };
  }
  const writeRoots = await Promise.all(active.writeRoots.map((candidate) => resolveIntendedPath(candidate)));
  if (!writeRoots.some((candidate) => pathWithin(candidate, resolvedRoot))) {
    return {
      ok: false,
      error: presentationError(
        "artifact_root_not_writable",
        `presentation retention root is not authorized by the active write boundary: ${where}`,
        "delivery",
        "artifact",
      ),
    };
  }
  return { ok: true, resolvedRoot };
}

function validateGeneratedAt(generatedAt: string): boolean {
  return !Number.isNaN(Date.parse(generatedAt)) && generatedAt.includes("T");
}

function referencesFor(records: readonly GuardedRetrievalRecord[]): Array<{ recordId: string; sourceUri: string; relativePath: string }> {
  return records
    .map((record) => ({ recordId: record.record.id, sourceUri: record.sourceUri, relativePath: record.relativePath }))
    .sort((left, right) => left.recordId.localeCompare(right.recordId));
}

function recordsForView(records: readonly GuardedRetrievalRecord[]): readonly KnowledgeRecord[] {
  return deepFreeze(records.map((record) => record.record));
}

function validateRecommendationIds(
  records: readonly GuardedRetrievalRecord[],
  recommendationIds: readonly string[],
): KnowledgeError[] {
  const errors: KnowledgeError[] = [];
  for (const id of recommendationIds) {
    const record = records.find((candidate) => candidate.record.id === id)?.record;
    if (record === undefined || record.kind !== "recommendation" || record.status !== "active") {
      errors.push(presentationError("recommendation_invalid", `recommendation ${id} is not an authorized active recommendation record`, "recommendationIds", "authorization"));
    }
  }
  return errors;
}

function authorizedRecommendationStatements(
  records: readonly GuardedRetrievalRecord[],
  recommendationIds: readonly string[],
): Set<string> {
  const statements = new Set<string>();
  for (const id of recommendationIds) {
    const record = records.find((candidate) => candidate.record.id === id)?.record;
    if (record !== undefined && record.kind === "recommendation" && record.status === "active") {
      statements.add(record.statement);
    }
  }
  return statements;
}

function validateAdaptation(
  projection: SemanticProjection,
  draft: PresentationDraft,
  records: readonly GuardedRetrievalRecord[],
): KnowledgeError[] {
  const errors = validateDraft(draft);
  if (!subsetOf(draft.facts, projection.facts)) errors.push(presentationError("fact_not_in_view", "audience facts must be selected from the audience-independent view"));
  if (!subsetOf(draft.uncertainty, projection.uncertainty)) errors.push(presentationError("uncertainty_not_in_view", "audience uncertainty must be selected from the audience-independent view"));
  if (!projection.requiredFacts.every((fact) => draft.facts.includes(fact))) errors.push(presentationError("required_fact_hidden", "audience adaptation omitted a required baseline fact"));
  if (!projection.uncertainty.every((item) => draft.uncertainty.includes(item))) errors.push(presentationError("uncertainty_hidden", "audience adaptation omitted explicit uncertainty"));

  // Every rendered action must be traceable to what authorizes it: either it
  // is one of the view's own actions, or it is exactly the statement of a
  // record the draft cites as an authorized active recommendation. This runs
  // unconditionally, not gated on whether the action set changed — citing
  // the right recommendation id must not excuse inventing different action
  // prose.
  const authorizedStatements = authorizedRecommendationStatements(records, draft.recommendationIds);
  for (const action of draft.actions) {
    if (!projection.actions.includes(action) && !authorizedStatements.has(action)) {
      errors.push(presentationError(
        "action_unauthorized",
        `audience action "${action}" is neither a view action nor the statement of a cited authorized recommendation`,
        "audience.actions",
      ));
    }
  }

  const actionChanged = !sameSet(projection.actions, draft.actions);
  if (actionChanged && draft.recommendationIds.length === 0) {
    errors.push(presentationError("recommendation_required", "an action-changing adaptation requires a distinct authorized recommendation"));
  }
  if (actionChanged && !draft.recommendationIds.some((id) => !projection.recommendationIds.includes(id))) {
    errors.push(presentationError("recommendation_distinct_required", "an action-changing adaptation must cite an authorized recommendation not used for the baseline action"));
  }
  errors.push(...validateRecommendationIds(records, draft.recommendationIds));
  return errors;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// `presentationId` is deterministic given the request and `generatedAt`, so a
// byte-identical re-render targets the same final directory. `rename` onto a
// non-empty destination fails with an opaque ENOTEMPTY; detect the collision
// before doing any pending-directory work and refuse explicitly instead of
// treating the second render as silently idempotent.
class PresentationAlreadyRetainedError extends Error {}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}

async function retain(
  active: ActiveSpace,
  authorizedRoot: string,
  content: string,
  receipt: PresentationReceipt,
  writer: (path: string, content: string) => Promise<void>,
): Promise<RetainedPresentation> {
  const paths = retentionPaths(active, receipt.presentationId);
  await mkdir(paths.root, { recursive: true });
  // The root existed as a resolved, authorized path when the boundary was
  // checked; confirm the directory just created is still that path before
  // anything is written into it.
  const createdRoot = await realpath(paths.root);
  if (createdRoot !== authorizedRoot) {
    throw new Error(`presentation retention root changed after authorization: expected ${authorizedRoot}, found ${createdRoot}`);
  }
  if (await directoryExists(paths.directory)) {
    throw new PresentationAlreadyRetainedError(`presentation ${receipt.presentationId} is already retained at ${paths.directory}`);
  }
  const temporaryDirectory = await mkdtemp(join(paths.root, ".engram-presentation-pending-"));
  try {
    await writer(join(temporaryDirectory, "presentation.md"), content);
    await writer(join(temporaryDirectory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    await rename(temporaryDirectory, paths.directory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { artifactPath: paths.artifact, receiptPath: paths.receipt };
}

function presentationIdentity(
  active: ActiveSpace,
  request: { pack: { id: string; version: string }; model: string },
  view: ViewDefinition,
  audience: AudienceDefinition,
  delivery: DeliveryDefinition,
  records: readonly GuardedRetrievalRecord[],
  retrieval: RetrievalReceipt,
  recommendationIds: readonly string[],
  draft: PresentationDraft,
  generatedAt: string,
): Record<string, unknown> {
  return {
    activeSpace: active.spaceId,
    viewId: view.id,
    viewVersion: view.version,
    audienceId: audience.id,
    audienceVersion: audience.version,
    deliveryId: delivery.id,
    deliveryVersion: delivery.version,
    sourceRecordIds: records.map((record) => record.record.id).sort(),
    sourceReferences: referencesFor(records),
    retrievalReceipt: retrieval,
    pack: { id: request.pack.id, version: request.pack.version },
    model: request.model,
    recommendationIds: [...recommendationIds],
    generatedAt,
    content: renderContent(draft, delivery),
  };
}

export async function renderPresentation(
  request: PresentationRequest,
  options: PresentationOptions = {},
): Promise<PresentationOutcome> {
  const env = options.env ?? process.env;
  const activeResult = await resolveActiveSpace(env);
  if (!activeResult.ok) {
    return failure(activeResult.errors.map((message) => presentationError("active_space_unresolved", message, undefined, "authorization")));
  }
  const active = activeResult.value;
  const requestSnapshot = Object.freeze({
    viewId: request.viewId,
    audienceId: request.audienceId,
    deliveryId: request.deliveryId,
    query: request.query,
    model: request.model,
    generatedAt: request.generatedAt,
    pack: Object.freeze({ id: request.pack.id, version: request.pack.version }),
  });
  if (!isInstalled(active, request.pack)) {
    return failure([presentationError(
      "pack_not_installed",
      `presentation pack ${requestSnapshot.pack.id}@${requestSnapshot.pack.version} is not installed in the active space`,
      "pack",
      "authorization",
    )]);
  }
  if (!active.allowedModels.includes(requestSnapshot.model)) {
    return failure([presentationError("model_not_allowed", `model ${requestSnapshot.model} is not allowed by the active space`, "model", "authorization")]);
  }
  const view = findView(request.pack, requestSnapshot.viewId);
  if (view === undefined) return failure([presentationError("view_unknown", `view ${requestSnapshot.viewId} is not configured by the presentation pack`, "viewId")]);
  if (view.scope !== "search" && view.scope !== "space") {
    return failure([presentationError("view_scope_invalid", "view scope must be search or space", "viewId")]);
  }
  const audience = findAudience(request.pack, requestSnapshot.audienceId);
  if (audience === undefined) return failure([presentationError("audience_unknown", `audience ${requestSnapshot.audienceId} is not configured by the presentation pack`, "audienceId", "authorization")]);
  const declaredDelivery = findDelivery(request.pack, requestSnapshot.deliveryId);
  if (declaredDelivery === undefined) return failure([presentationError("delivery_unknown", `delivery ${requestSnapshot.deliveryId} is not configured by the presentation pack`, "deliveryId")]);
  const viewSnapshot = Object.freeze({ id: view.id, version: view.version, scope: view.scope, retrievalQuery: view.retrievalQuery, project: view.project });
  const audienceSnapshot = Object.freeze({ id: audience.id, version: audience.version, authorize: audience.authorize, adapt: audience.adapt });
  // Everything downstream reads this snapshot, never the pack's live object, so
  // a callback that mutates what it was handed cannot move a guard it already
  // passed or one it has not reached yet.
  const delivery = snapshotDelivery(declaredDelivery);
  if (!Number.isSafeInteger(viewSnapshot.version) || viewSnapshot.version < 0 || !Number.isSafeInteger(audienceSnapshot.version) || audienceSnapshot.version < 0 || !Number.isSafeInteger(delivery.version) || delivery.version < 0) {
    return failure([presentationError("definition_version_invalid", "view, audience, and delivery versions must be non-negative integers")]);
  }
  if (!Number.isSafeInteger(delivery.maxWords) || delivery.maxWords <= 0) {
    return failure([presentationError("delivery_constraint_invalid", "delivery maxWords must be a positive integer", "deliveryId")]);
  }
  if (requestSnapshot.generatedAt !== undefined && !validateGeneratedAt(requestSnapshot.generatedAt)) {
    return failure([presentationError("generated_at_invalid", "generatedAt must be an ISO-like timestamp", "generatedAt")]);
  }
  // Resolved once, here, and carried to `retain`. `delivery.retain` is read off
  // the snapshot, so a callback cannot turn retention on after this point.
  let retentionRoot: string | undefined;
  if (delivery.retain) {
    const boundary = await retentionBoundary(active, delivery);
    if (!boundary.ok) return failure([boundary.error]);
    retentionRoot = boundary.resolvedRoot;
  }

  let retrieval: GuardedRetrievalOutcome;
  if (viewSnapshot.scope === "space") {
    // Refuse rather than ignore: silently dropping a caller-supplied query
    // on an enumerating view would let the caller believe they had narrowed
    // a result set that was in fact returned whole.
    if (requestSnapshot.query !== undefined) {
      return failure([presentationError("query_not_scoped", "a space-scoped view does not accept a caller-supplied query", "query", "retrieval")]);
    }
    retrieval = await guardedEnumerateInActiveSpace(
      active,
      { audienceId: audienceSnapshot.id, viewId: viewSnapshot.id, pack: request.pack },
      options,
    );
  } else {
    let retrievalQuery: string;
    try {
      retrievalQuery = viewSnapshot.retrievalQuery(requestSnapshot.query);
    } catch (error) {
      return failure([presentationError("view_query_failed", `view retrieval query failed: ${error instanceof Error ? error.message : String(error)}`)]);
    }
    retrieval = await guardedRetrieveInActiveSpace(
      active,
      {
        query: retrievalQuery,
        audienceId: audienceSnapshot.id,
        viewId: viewSnapshot.id,
        pack: request.pack,
      },
      options,
    );
  }
  if (retrieval.status === "failed") return failure(retrieval.errors, retrieval.receipt);
  if (retrieval.status === "miss") {
    return failure([presentationError("retrieval_miss", "the view has no eligible current records; a miss is not evidence of absence", "query", "retrieval")], retrieval.receipt);
  }

  const records = retrieval.records;
  let projection: SemanticProjection;
  try {
    projection = snapshotProjection(viewSnapshot.project(recordsForView(records)));
  } catch (error) {
    return failure([presentationError("view_projection_failed", `view projection failed: ${error instanceof Error ? error.message : String(error)}`)], retrieval.receipt);
  }
  const projectionErrors = validateProjection(projection, records);
  if (projectionErrors.length > 0) return failure(projectionErrors, retrieval.receipt);

  let draft: PresentationDraft;
  try {
    draft = snapshotDraft(audienceSnapshot.adapt({ projection, delivery, records: recordsForView(records) }));
  } catch (error) {
    return failure([presentationError("audience_adaptation_failed", `audience adaptation failed: ${error instanceof Error ? error.message : String(error)}`)], retrieval.receipt);
  }
  const adaptationErrors = validateAdaptation(projection, draft, records);
  if (adaptationErrors.length > 0) return failure(adaptationErrors, retrieval.receipt);

  const recommendationIds = uniqueStrings([...projection.recommendationIds, ...draft.recommendationIds]);
  const generatedAt = requestSnapshot.generatedAt ?? new Date().toISOString();
  const content = renderContent(draft, delivery);
  if (wordCount(content) > delivery.maxWords) {
    return failure([presentationError("delivery_limit_exceeded", `rendered presentation exceeds the ${delivery.maxWords}-word delivery limit`, "deliveryId")], retrieval.receipt);
  }
  const identity = presentationIdentity(active, { pack: requestSnapshot.pack, model: requestSnapshot.model }, viewSnapshot, audienceSnapshot, delivery, records, retrieval.receipt, recommendationIds, draft, generatedAt);
  const presentationId = `presentation-${createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex").slice(0, 32)}`;
  const retainedPaths = delivery.retain ? retentionPaths(active, presentationId) : undefined;
  const receipt: PresentationReceipt = {
    schemaVersion: 0,
    presentationId,
    activeSpace: active.spaceId,
    viewId: viewSnapshot.id,
    viewVersion: viewSnapshot.version,
    audienceId: audienceSnapshot.id,
    audienceVersion: audienceSnapshot.version,
    deliveryId: delivery.id,
    deliveryVersion: delivery.version,
    sourceRecordIds: records.map((record) => record.record.id).sort(),
    sourceReferences: referencesFor(records),
    retrievalReceipt: retrieval.receipt,
    pack: { id: requestSnapshot.pack.id, version: requestSnapshot.pack.version },
    model: requestSnapshot.model,
    recommendationIds,
    generatedAt,
    ...(retainedPaths === undefined ? {} : {
      retention: {
        artifactReference: retainedPaths.artifactReference,
        receiptReference: retainedPaths.receiptReference,
      },
    }),
  };

  if (!delivery.retain || retentionRoot === undefined) return { schema_version: 0, status: "presented", content, receipt };
  const writer = options.writeRetentionFile ?? ((path: string, value: string) => writeFile(path, value, "utf8"));
  try {
    const retained = await retain(active, retentionRoot, content, receipt, writer);
    return { schema_version: 0, status: "presented", content, receipt, retained };
  } catch (error) {
    if (error instanceof PresentationAlreadyRetainedError) {
      return failure([presentationError(
        "presentation_already_retained",
        error.message,
        "deliveryId",
        "artifact",
      )], retrieval.receipt);
    }
    return failure([presentationError(
      "artifact_write_failed",
      `presentation retention failed: ${error instanceof Error ? error.message : String(error)}`,
      "deliveryId",
      "artifact",
    )], retrieval.receipt);
  }
}
