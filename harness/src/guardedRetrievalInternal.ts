import {
  retrieveEnumeratedRecords,
  retrieveGuardedRecords,
  type GuardedRetrievalFilter,
  type RetrievalOutcome,
  type RetrievalReceipt,
} from "./knowledgeRetrieval.ts";
import type { ActiveSpace } from "./spaceRegistry.ts";
import type {
  GuardedEnumerationRequest,
  GuardedRetrievalFailure,
  GuardedRetrievalOptions,
  GuardedRetrievalOutcome,
  GuardedRetrievalRecord,
  GuardedRetrievalRequest,
  UnresolvedRetrievalReceipt,
} from "./guardedRetrieval.ts";
import type { KnowledgeError, PresentationPack } from "./knowledgeTypes.ts";

function retrievalError(code: string, message: string, field?: string): KnowledgeError {
  return field === undefined
    ? { kind: "retrieval", code, message }
    : { kind: "retrieval", code, field, message };
}

export function receiptFor(
  active: ActiveSpace,
  query: string | null,
  scope: "search" | "space",
  requestedSourceClasses: readonly string[],
  allowedSourceClasses: readonly string[],
): RetrievalReceipt;
export function receiptFor(
  active: null,
  query: string | null,
  scope: "search" | "space",
  requestedSourceClasses: readonly string[],
  allowedSourceClasses: readonly string[],
): UnresolvedRetrievalReceipt;
export function receiptFor(
  active: ActiveSpace | null,
  query: string | null,
  scope: "search" | "space",
  requestedSourceClasses: readonly string[],
  allowedSourceClasses: readonly string[],
): RetrievalReceipt | UnresolvedRetrievalReceipt {
  return {
    schemaVersion: 0,
    scope,
    query,
    activeSpace: active === null ? null : active.spaceId,
    collection: active === null ? "" : active.qmdCollectionName,
    requestedSourceClasses: [...requestedSourceClasses],
    allowedSourceClasses: [...allowedSourceClasses],
    kind: "miss",
    locatorUris: [],
    recordIds: [],
    exposedResults: [],
    // No filtering — let alone ranking — has run yet at any of this
    // function's call sites (pack validation, installation, query shape,
    // audience lookup, source-class authorization, or query-strategy
    // failures, plus the "no active space" case handled by guardedRetrieve
    // before any of the above even runs), so there is no threshold to report
    // and no withholding to disclose.
    relevanceThreshold: null,
    withheld: { audienceId: null, count: 0 },
  };
}

function failure(
  active: ActiveSpace,
  query: string | null,
  scope: "search" | "space",
  requestedSourceClasses: readonly string[],
  allowedSourceClasses: readonly string[],
  errors: KnowledgeError[],
): GuardedRetrievalFailure {
  return {
    schema_version: 0,
    status: "failed",
    errors,
    receipt: receiptFor(active, query, scope, requestedSourceClasses, allowedSourceClasses),
  };
}

function activePackInstalled(active: ActiveSpace, pack: PresentationPack): boolean {
  return active.packs.some((installed) => installed.id === pack.id && installed.version === pack.version);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : undefined;
}

function functionValue(value: unknown): Function | undefined {
  return typeof value === "function" ? value : undefined;
}

type PolicySnapshot = {
  allowedSourceClasses: string[];
  queryStrategy: PresentationPack["retrievalPolicy"]["queryStrategy"];
  classifySource: PresentationPack["retrievalPolicy"]["classifySource"];
  relevanceThreshold: number | null;
  isEligible: PresentationPack["retrievalPolicy"]["isEligible"];
  includePresentations: unknown;
};

function snapshotPolicy(pack: unknown): { ok: true; value: PolicySnapshot } | { ok: false; allowedSourceClasses: string[]; errors: KnowledgeError[] } {
  if (!isObject(pack) || !isObject(pack.retrievalPolicy)) {
    return { ok: false, allowedSourceClasses: [], errors: [retrievalError("policy_shape_invalid", "retrieval policy must be an object", "pack")] };
  }
  const policy = pack.retrievalPolicy;
  const allowedSourceClasses = stringArray(policy.allowedSourceClasses);
  if (allowedSourceClasses === undefined) {
    return { ok: false, allowedSourceClasses: [], errors: [retrievalError("policy_shape_invalid", "retrieval policy allowedSourceClasses must be an array of strings", "pack")] };
  }
  const queryStrategy = functionValue(policy.queryStrategy);
  const classifySource = functionValue(policy.classifySource);
  const isEligible = functionValue(policy.isEligible);
  if (queryStrategy === undefined || classifySource === undefined || isEligible === undefined) {
    return { ok: false, allowedSourceClasses, errors: [retrievalError("policy_shape_invalid", "retrieval policy callbacks must be functions", "pack")] };
  }
  if (policy.includePresentations !== false) {
    return { ok: true, value: {
      allowedSourceClasses,
      queryStrategy: (input) => Reflect.apply(queryStrategy, undefined, [input]),
      classifySource: (source) => Reflect.apply(classifySource, undefined, [source]),
      relevanceThreshold: typeof policy.relevanceThreshold === "number" || policy.relevanceThreshold === null ? policy.relevanceThreshold : Number.NaN,
      isEligible: (record) => Reflect.apply(isEligible, undefined, [record]),
      includePresentations: policy.includePresentations,
    } };
  }
  return { ok: true, value: {
    allowedSourceClasses,
    queryStrategy: (input) => Reflect.apply(queryStrategy, undefined, [input]),
    classifySource: (source) => Reflect.apply(classifySource, undefined, [source]),
    relevanceThreshold: typeof policy.relevanceThreshold === "number" || policy.relevanceThreshold === null ? policy.relevanceThreshold : Number.NaN,
    isEligible: (record) => Reflect.apply(isEligible, undefined, [record]),
    includePresentations: false,
  } };
}

function validatePolicy(policy: PolicySnapshot): KnowledgeError[] {
  const errors: KnowledgeError[] = [];
  if (policy.includePresentations !== false) {
    errors.push(retrievalError("policy_presentations_included", "retrieval policy must exclude presentation artifacts"));
  }
  if (policy.allowedSourceClasses.length === 0) {
    errors.push(retrievalError("policy_source_classes_empty", "retrieval policy must declare at least one allowed source class"));
  }
  if (
    policy.relevanceThreshold !== null &&
    (!Number.isFinite(policy.relevanceThreshold) || policy.relevanceThreshold < 0)
  ) {
    errors.push(retrievalError("policy_relevance_threshold_invalid", "retrieval policy relevance threshold must be null or a non-negative finite number"));
  }
  return errors;
}

// "search" runs the pack's declared query strategy over a ranked qmd search;
// "space" enumerates every Markdown record under the active space's records
// root and runs no qmd process. Everything in `performRetrieval` below this
// point — policy validation, pack installation, audience lookup, source-class
// authorization — applies identically to both; only query construction and
// the final retrieval call differ, so neither mode can silently skip a guard
// the other one runs.
type RetrievalMode =
  | { kind: "search"; query: string }
  | { kind: "space" };

async function performRetrieval(
  active: ActiveSpace,
  mode: RetrievalMode,
  request: GuardedEnumerationRequest,
  options: GuardedRetrievalOptions,
): Promise<GuardedRetrievalOutcome> {
  const policySnapshot = snapshotPolicy(request.pack);
  const baseQuery: string | null = mode.kind === "search" ? mode.query : null;
  const scope = mode.kind;
  const initialAllowedSourceClasses = policySnapshot.ok ? policySnapshot.value.allowedSourceClasses : policySnapshot.allowedSourceClasses;
  const requestedSourceClasses = request.requestedSourceClasses === undefined
    ? [...initialAllowedSourceClasses]
    : uniqueStrings(request.requestedSourceClasses);
  if (!policySnapshot.ok) {
    return failure(active, baseQuery, scope, requestedSourceClasses, policySnapshot.allowedSourceClasses, policySnapshot.errors);
  }
  const policy = policySnapshot.value;

  const packErrors = validatePolicy(policy);
  if (packErrors.length > 0) {
    return failure(active, baseQuery, scope, requestedSourceClasses, policy.allowedSourceClasses, packErrors);
  }
  if (!activePackInstalled(active, request.pack)) {
    return failure(active, baseQuery, scope, requestedSourceClasses, policy.allowedSourceClasses, [retrievalError(
      "pack_not_installed",
      `presentation pack ${request.pack.id}@${request.pack.version} is not installed in the active space`,
      "pack",
    )]);
  }
  if (mode.kind === "search" && (typeof mode.query !== "string" || mode.query.trim().length === 0 || mode.query.includes("\u0000"))) {
    return failure(active, baseQuery, scope, requestedSourceClasses, policy.allowedSourceClasses, [retrievalError(
      "query_invalid",
      "retrieval query must be a non-empty string without NUL bytes",
      "query",
    )]);
  }
  const audience = request.pack.audiences.find((candidate) => candidate.id === request.audienceId);
  if (audience === undefined) {
    return failure(active, baseQuery, scope, requestedSourceClasses, policy.allowedSourceClasses, [retrievalError(
      "audience_unknown",
      `audience ${request.audienceId} is not configured by the presentation pack`,
      "audience",
    )]);
  }
  const audienceSnapshot = Object.freeze({ id: audience.id, authorize: audience.authorize });
  const disallowedRequestedClass = requestedSourceClasses.find(
    (sourceClass) => !policy.allowedSourceClasses.includes(sourceClass),
  );
  if (disallowedRequestedClass !== undefined) {
    return failure(active, baseQuery, scope, requestedSourceClasses, policy.allowedSourceClasses, [retrievalError(
      "source_class_not_allowed",
      `requested source class ${disallowedRequestedClass} is not allowed by the retrieval policy`,
      "requestedSourceClasses",
    )]);
  }
  if (requestedSourceClasses.length === 0) {
    return {
      schema_version: 0,
      status: "miss",
      records: [],
      receipt: receiptFor(active, baseQuery, scope, requestedSourceClasses, policy.allowedSourceClasses),
    };
  }

  const filter: GuardedRetrievalFilter = {
    audienceId: audienceSnapshot.id,
    requestedSourceClasses,
    allowedSourceClasses: policy.allowedSourceClasses,
    includePresentations: false,
    relevanceThreshold: policy.relevanceThreshold,
    classifySource: policy.classifySource,
    isEligible: policy.isEligible,
    authorize: audienceSnapshot.authorize,
  };

  let retrieval: RetrievalOutcome;
  if (mode.kind === "search") {
    let query: string;
    try {
      query = policy.queryStrategy({
        query: mode.query,
        ...(request.viewId === undefined ? {} : { viewId: request.viewId }),
        requestedSourceClasses,
      });
    } catch (error) {
      return failure(active, baseQuery, scope, requestedSourceClasses, policy.allowedSourceClasses, [retrievalError(
        "query_strategy_failed",
        `retrieval query strategy failed: ${error instanceof Error ? error.message : String(error)}`,
      )]);
    }
    if (typeof query !== "string" || query.trim().length === 0 || query.includes("\u0000")) {
      return failure(active, baseQuery, scope, requestedSourceClasses, policy.allowedSourceClasses, [retrievalError(
        "query_strategy_invalid",
        "retrieval query strategy returned an empty or unsafe query",
      )]);
    }
    retrieval = await retrieveGuardedRecords(active, query, filter, options.spawnFn);
  } else {
    retrieval = await retrieveEnumeratedRecords(active, filter);
  }

  if (retrieval.kind === "failure") return { schema_version: 0, status: "failed", errors: retrieval.errors, receipt: retrieval.receipt };
  if (retrieval.kind === "miss") return { schema_version: 0, status: "miss", records: [], receipt: retrieval.receipt };

  const records: GuardedRetrievalRecord[] = [];
  for (const related of retrieval.records) {
    const exposed = retrieval.receipt.exposedResults.find((candidate) => candidate.recordId === related.record.id);
    if (exposed === undefined) {
      return failure(active, baseQuery, scope, requestedSourceClasses, policy.allowedSourceClasses, [retrievalError(
        "receipt_incomplete",
        "retrieval receipt did not contain a reference for every exposed record",
      )]);
    }
    records.push({
      record: related.record,
      relativePath: related.relativePath,
      sourceUri: related.sourceUri,
      sourceClasses: [...exposed.sourceClasses],
      ...(exposed.score === undefined ? {} : { score: exposed.score }),
    });
  }
  return { schema_version: 0, status: "hit", records, receipt: retrieval.receipt };
}

export async function guardedRetrieveInActiveSpace(
  active: ActiveSpace,
  request: GuardedRetrievalRequest,
  options: GuardedRetrievalOptions = {},
): Promise<GuardedRetrievalOutcome> {
  return performRetrieval(active, { kind: "search", query: request.query }, request, options);
}

// The space-scoped counterpart used only by `renderPresentation` when a
// view's scope is "space": no query is ever constructed or validated, and
// the final retrieval call enumerates the records root instead of running a
// qmd search. Every other guard above is shared, unchanged, with
// `guardedRetrieveInActiveSpace`.
export async function guardedEnumerateInActiveSpace(
  active: ActiveSpace,
  request: GuardedEnumerationRequest,
  options: GuardedRetrievalOptions = {},
): Promise<GuardedRetrievalOutcome> {
  return performRetrieval(active, { kind: "space" }, request, options);
}
