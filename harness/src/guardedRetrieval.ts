import { guardedRetrieveInActiveSpace, receiptFor } from "./guardedRetrievalInternal.ts";
import type { RetrievalReceipt } from "./knowledgeRetrieval.ts";
import type { SpawnFn } from "./qmdRunner.ts";
import { resolveActiveSpace, type ActiveSpace } from "./spaceRegistry.ts";
import type { EnvLike, Result } from "./types.ts";
import type {
  KnowledgeError,
  KnowledgeRecord,
  PresentationPack,
} from "./knowledgeTypes.ts";

export type GuardedRetrievalRequest = {
  query: string;
  audienceId: string;
  pack: PresentationPack;
  viewId?: string;
  requestedSourceClasses?: readonly string[];
};

// A space-scoped view's retrieval: enumerates every eligible record under
// the active space's records root instead of running a ranked qmd search.
// No `query` field — an enumerating view accepts no caller-supplied query
// at all (see presentation.ts's `query_not_scoped` refusal).
export type GuardedEnumerationRequest = {
  audienceId: string;
  pack: PresentationPack;
  viewId?: string;
  requestedSourceClasses?: readonly string[];
};

export type GuardedRetrievalRecord = {
  record: KnowledgeRecord;
  relativePath: string;
  sourceUri: string;
  sourceClasses: string[];
  score?: number;
};

export type GuardedRetrievalHit = {
  schema_version: 0;
  status: "hit";
  records: GuardedRetrievalRecord[];
  receipt: RetrievalReceipt;
};

export type GuardedRetrievalMiss = {
  schema_version: 0;
  status: "miss";
  records: [];
  receipt: RetrievalReceipt;
};

export type GuardedRetrievalFailure = {
  schema_version: 0;
  status: "failed";
  errors: KnowledgeError[];
  receipt: RetrievalReceipt;
};

export type GuardedRetrievalOutcome = GuardedRetrievalHit | GuardedRetrievalMiss | GuardedRetrievalFailure;

export type GuardedRetrievalOptions = {
  env?: EnvLike;
  spawnFn?: SpawnFn;
};

// A receipt for the "no active space" failure: guardedRetrieve cannot name
// a space it never resolved, so this is a distinct type rather than a
// fabricated ActiveSpace fed through the ordinary receipt shape.
export type UnresolvedRetrievalReceipt = Omit<RetrievalReceipt, "activeSpace"> & { activeSpace: null };

export type GuardedRetrievalUnresolvedFailure = {
  schema_version: 0;
  status: "failed";
  errors: KnowledgeError[];
  receipt: UnresolvedRetrievalReceipt;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Mirrors the defensiveness already applied to `request.query` below: this
// runs before any pack validation, so `request.pack` cannot be trusted to
// match its declared type at runtime.
function allowedSourceClassesOf(pack: unknown): readonly string[] {
  if (!isObject(pack)) return [];
  const policy = pack.retrievalPolicy;
  if (!isObject(policy)) return [];
  const allowed = policy.allowedSourceClasses;
  if (!Array.isArray(allowed)) return [];
  return allowed.filter((entry): entry is string => typeof entry === "string");
}

export async function guardedRetrieve(
  request: GuardedRetrievalRequest,
  options: GuardedRetrievalOptions = {},
): Promise<GuardedRetrievalOutcome | GuardedRetrievalUnresolvedFailure> {
  const env = options.env ?? process.env;
  const activeResult: Result<ActiveSpace> = await resolveActiveSpace(env);
  if (!activeResult.ok) {
    return {
      schema_version: 0,
      status: "failed",
      errors: activeResult.errors.map((message) => ({ kind: "retrieval", code: "active_space_unresolved", message })),
      receipt: receiptFor(
        null,
        typeof request.query === "string" ? request.query : null,
        "search",
        request.requestedSourceClasses === undefined ? [] : request.requestedSourceClasses,
        allowedSourceClassesOf(request.pack),
      ),
    };
  }
  return guardedRetrieveInActiveSpace(activeResult.value, request, options);
}

export function isGuardedRetrievalHit(result: GuardedRetrievalOutcome): result is GuardedRetrievalHit {
  return result.status === "hit";
}

export function isGuardedRetrievalMiss(result: GuardedRetrievalOutcome): result is GuardedRetrievalMiss {
  return result.status === "miss";
}

export function isGuardedRetrievalFailure(result: GuardedRetrievalOutcome): result is GuardedRetrievalFailure {
  return result.status === "failed";
}
