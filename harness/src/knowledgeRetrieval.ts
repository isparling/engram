import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, posix, relative, resolve, sep } from "node:path";
import { runQmd, type SpawnFn } from "./qmdRunner.ts";
import { parseKnowledgeRecord } from "./knowledgeRecord.ts";
import type { ActiveSpace } from "./spaceRegistry.ts";
import type { KnowledgeError, KnowledgeRecord, RelatedKnowledgeRecord } from "./knowledgeTypes.ts";
import { deepFreeze } from "./deepFreeze.ts";

export type RetrievalExposedResult = {
  recordId: string;
  sourceUri: string;
  relativePath: string;
  sourceClasses: string[];
  score?: number;
};

// What audience-authorization filtering withheld from this retrieval. It
// deliberately carries no record identities, only a count: an identity would
// let a caller enumerate specific restricted content by name, where a count
// only supports probabilistic inference over many queries.
//
// This field is INTENDED as the machine operator's audit trail. It is not yet
// confined to one: `cli.ts` prints the entire result, receipt included, to the
// requesting caller, so today the count reaches the same channel as the
// records. The current disclosure is intentional: a count is a weak oracle
// and no current space holds records whose mere existence is sensitive.
//
// The revisit trigger is exactly that condition. When a space does hold such
// records, this must become operator-only, and the intended shape of that
// change is a redaction at the caller-facing boundary — the same place
// safeForModel already redacts — leaving this type untouched. Keep any
// audience-facing disclosure structurally separate from this field so that
// change stays a policy edit and never becomes a schema migration.
export type RetrievalWithheld = {
  audienceId: string | null;
  count: number;
};

export type RetrievalReceipt = {
  schemaVersion: 0;
  // "search" retrievals ran a qmd query; "space" retrievals enumerated the
  // records root directly and ran no qmd process at all. `query` and
  // `relevanceThreshold` are only meaningful for "search" — see below.
  scope: "search" | "space";
  // null for an enumerated ("space") retrieval: no query ran, and writing
  // anything else here (the view id, an empty string standing in for "none")
  // would be a fabricated query, the same defect as the fabricated space id
  // already refused for UnresolvedRetrievalReceipt.
  query: string | null;
  activeSpace: string;
  collection: string;
  requestedSourceClasses: string[];
  allowedSourceClasses: string[];
  kind: "hit" | "miss";
  locatorUris: string[];
  recordIds: string[];
  exposedResults: RetrievalExposedResult[];
  // The relevance threshold actually applied to rank candidates, or null when
  // none was. Enumeration never ranks, so an enumerated receipt always
  // reports null here even when the pack's policy declares a threshold:
  // reporting the declared threshold would claim a filter that never ran.
  relevanceThreshold: number | null;
  withheld: RetrievalWithheld;
};

export type RetrievalFailure = {
  kind: "failure";
  errors: KnowledgeError[];
  receipt: RetrievalReceipt;
};

export type RetrievalMiss = {
  kind: "miss";
  records: [];
  receipt: RetrievalReceipt;
};

export type RetrievalHit = {
  kind: "hit";
  records: RelatedKnowledgeRecord[];
  receipt: RetrievalReceipt;
};

export type RetrievalOutcome = RetrievalFailure | RetrievalMiss | RetrievalHit;

function retrievalError(code: string, message: string, field?: string): KnowledgeError {
  return field === undefined
    ? { kind: "retrieval", code, message }
    : { kind: "retrieval", code, field, message };
}

function safeForModel(error: KnowledgeError, guarded: boolean): KnowledgeError {
  if (!guarded) return error;
  return {
    ...error,
    message: `guarded retrieval rejected qmd output (${error.code})`,
  };
}

function emptyReceipt(
  binding: ActiveSpace,
  query: string | null,
  kind: "hit" | "miss" = "miss",
  scope: "search" | "space" = "search",
): RetrievalReceipt {
  return {
    schemaVersion: 0,
    scope,
    query,
    activeSpace: binding.spaceId,
    collection: binding.qmdCollectionName,
    requestedSourceClasses: [],
    allowedSourceClasses: [],
    kind,
    locatorUris: [],
    recordIds: [],
    exposedResults: [],
    relevanceThreshold: null,
    withheld: { audienceId: null, count: 0 },
  };
}

export type GuardedRetrievalFilter = {
  audienceId: string;
  requestedSourceClasses: readonly string[];
  allowedSourceClasses: readonly string[];
  includePresentations: false;
  relevanceThreshold: number | null;
  classifySource: (source: KnowledgeRecord["sources"][number]) => string;
  isEligible: (record: KnowledgeRecord) => boolean;
  authorize: (record: KnowledgeRecord) => boolean;
};

// A candidate Markdown locator awaiting the guard sequence below. `score`
// is qmd's ranking signal; enumeration never ranks, so its candidates never
// carry one.
export type RetrievalCandidate = {
  file: string;
  score?: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ENOENT");
}

function safeRelativeMarkdownPath(uri: string, collection: string): string | { error: KnowledgeError } {
  const prefix = `qmd://${collection}/`;
  if (!uri.startsWith(prefix)) return { error: retrievalError("foreign_locator", `qmd locator does not name the active collection: ${JSON.stringify(uri)}`, "file") };
  const relativePath = uri.slice(prefix.length);
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    relativePath.includes("\u0000") ||
    relativePath.includes("%") ||
    relativePath.startsWith("/") ||
    !relativePath.endsWith(".md")
  ) {
    return { error: retrievalError("locator_invalid", `qmd locator is not a safe relative Markdown path: ${JSON.stringify(uri)}`, "file") };
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return { error: retrievalError("locator_escape", `qmd locator contains an unsafe path segment: ${JSON.stringify(uri)}`, "file") };
  }
  if (posix.normalize(relativePath) !== relativePath || posix.isAbsolute(relativePath)) {
    return { error: retrievalError("locator_escape", `qmd locator is not normalized and relative: ${JSON.stringify(uri)}`, "file") };
  }
  return relativePath;
}

async function readLocatedRecord(
  binding: ActiveSpace,
  sourceUri: string,
  relativePath: string,
): Promise<{ kind: "record"; value: RelatedKnowledgeRecord } | { kind: "miss" } | { kind: "failure"; error: KnowledgeError }> {
  let root: string;
  try {
    root = await realpath(binding.recordsRoot);
  } catch (error) {
    if (isMissing(error)) return { kind: "miss" };
    return { kind: "failure", error: retrievalError("records_root_unavailable", `active records root could not be resolved: ${error instanceof Error ? error.message : String(error)}`, "file") };
  }
  const targetPath = resolve(root, ...relativePath.split("/"));
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (targetPath !== root && !targetPath.startsWith(rootWithSep)) {
    return { kind: "failure", error: retrievalError("path_escape", `locator resolves outside the active records root: ${sourceUri}`, "file") };
  }

  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(targetPath);
  } catch (error) {
    if (isMissing(error)) return { kind: "miss" };
    return { kind: "failure", error: retrievalError("record_read_failed", `failed to resolve current Markdown for ${sourceUri}: ${error instanceof Error ? error.message : String(error)}`, "file") };
  }
  if (resolvedTarget !== root && !resolvedTarget.startsWith(rootWithSep)) {
    return { kind: "failure", error: retrievalError("path_escape", `current Markdown path escapes the active records root: ${sourceUri}`, "file") };
  }
  try {
    if (!(await stat(resolvedTarget)).isFile()) {
      return { kind: "failure", error: retrievalError("record_shape_invalid", `qmd locator does not name a regular Markdown file: ${sourceUri}`, "file") };
    }
    const text = await readFile(resolvedTarget, "utf8");
    const parsed = parseKnowledgeRecord(text);
    if (!parsed.ok) {
      return { kind: "failure", error: retrievalError("current_markdown_invalid", `current Markdown for ${sourceUri} is invalid: ${parsed.errors.map((item) => item.message).join("; ")}`, "file") };
    }
    const expectedId = basename(relativePath, ".md");
    if (parsed.value.id !== expectedId) {
      return { kind: "failure", error: retrievalError("record_identity_mismatch", `current Markdown id ${parsed.value.id} does not match locator ${relativePath}`, "file") };
    }
    if (parsed.value.scope.space !== binding.spaceId) {
      return { kind: "failure", error: retrievalError("scope_space_mismatch", `current Markdown for ${sourceUri} belongs to another space`, "scope.space") };
    }
    return {
      kind: "record",
      value: { record: deepFreeze(parsed.value), relativePath, sourceUri },
    };
  } catch (error) {
    if (isMissing(error)) return { kind: "miss" };
    return { kind: "failure", error: retrievalError("record_read_failed", `failed to read current Markdown for ${sourceUri}: ${error instanceof Error ? error.message : String(error)}`, "file") };
  }
}

type CandidateFilterOutcome =
  | { kind: "failure"; error: KnowledgeError; withheldCount: number }
  | {
    kind: "complete";
    records: RelatedKnowledgeRecord[];
    locatorUris: string[];
    recordIds: string[];
    exposedResults: RetrievalExposedResult[];
    withheldCount: number;
  };

// The guard sequence every candidate locator passes through regardless of
// where it came from: containment (`safeRelativeMarkdownPath` /
// `readLocatedRecord`), source class, presentation exclusion, relevance,
// eligibility, authorization, and withheld-count bookkeeping. A search
// candidate carries a qmd score; an enumerated candidate never does, so
// `applyRelevanceThreshold` lets the caller say whether a score-bearing
// threshold check is even meaningful for this batch — enumeration passes
// `false` so an unscored candidate is never mistaken for one that failed
// to rank, which is a distinct thing from one that was never ranked at all.
async function filterCandidates(
  binding: ActiveSpace,
  candidates: readonly RetrievalCandidate[],
  filter: GuardedRetrievalFilter | undefined,
  applyRelevanceThreshold: boolean,
): Promise<CandidateFilterOutcome> {
  const records: RelatedKnowledgeRecord[] = [];
  const locatorUris: string[] = [];
  const recordIds: string[] = [];
  const exposedResults: RetrievalExposedResult[] = [];
  const seenPaths = new Set<string>();
  let withheldCount = 0;

  for (const candidate of candidates) {
    const safePath = safeRelativeMarkdownPath(candidate.file, binding.qmdCollectionName);
    if (typeof safePath !== "string") {
      return { kind: "failure", error: safeForModel(safePath.error, filter !== undefined), withheldCount };
    }
    if (seenPaths.has(safePath)) continue;
    seenPaths.add(safePath);
    const located = await readLocatedRecord(binding, candidate.file, safePath);
    if (located.kind === "failure") {
      return { kind: "failure", error: safeForModel(located.error, filter !== undefined), withheldCount };
    }
    if (located.kind === "miss") continue;

    if (filter !== undefined) {
      let sourceClasses: string[];
      try {
        sourceClasses = located.value.record.sources.map((source) => filter.classifySource(source));
      } catch (error) {
        return {
          kind: "failure",
          error: safeForModel(retrievalError(
            "source_classification_failed",
            `source classification policy failed: ${error instanceof Error ? error.message : String(error)}`,
          ), true),
          withheldCount,
        };
      }
      const sourceClassesAllowed = sourceClasses.length > 0 && sourceClasses.every(
        (sourceClass) => filter.allowedSourceClasses.includes(sourceClass) && filter.requestedSourceClasses.includes(sourceClass),
      );
      if (!sourceClassesAllowed) continue;
      if (!filter.includePresentations && sourceClasses.includes("presentation")) continue;
      if (
        applyRelevanceThreshold &&
        filter.relevanceThreshold !== null &&
        (candidate.score === undefined || candidate.score < filter.relevanceThreshold)
      ) continue;
      let eligible: boolean;
      try {
        eligible = filter.isEligible(located.value.record);
      } catch (error) {
        return {
          kind: "failure",
          error: safeForModel(retrievalError(
            "eligibility_policy_failed",
            `retrieval eligibility policy failed: ${error instanceof Error ? error.message : String(error)}`,
          ), true),
          withheldCount,
        };
      }
      if (!eligible) continue;
      let authorized: boolean;
      try {
        authorized = filter.authorize(located.value.record);
      } catch (error) {
        return {
          kind: "failure",
          error: safeForModel(retrievalError(
            "authorization_policy_failed",
            `retrieval authorization policy failed: ${error instanceof Error ? error.message : String(error)}`,
          ), true),
          withheldCount,
        };
      }
      // Authorization filters, like every other policy check above: an
      // unauthorized record is withheld and the loop continues, exactly as
      // source class, presentation-exclusion, relevance, and eligibility do.
      // It must never fail the whole request — a request-wide denial would
      // both destroy a render over an otherwise-authorized result set, and
      // let a caller who can never read restricted content learn whether
      // restricted content matched their query purely from outcome status.
      // The omission is recorded (see RetrievalWithheld above), not silent.
      if (typeof authorized !== "boolean") {
        return {
          kind: "failure",
          error: safeForModel(retrievalError(
            "authorization_policy_invalid",
            "retrieval authorization policy must return a boolean",
          ), true),
          withheldCount,
        };
      }
      if (authorized !== true) {
        withheldCount++;
        continue;
      }
      exposedResults.push({
        recordId: located.value.record.id,
        sourceUri: candidate.file,
        relativePath: safePath,
        sourceClasses,
        ...(candidate.score === undefined ? {} : { score: candidate.score }),
      });
    }
    locatorUris.push(candidate.file);
    recordIds.push(located.value.record.id);
    records.push(located.value);
  }
  return { kind: "complete", records, locatorUris, recordIds, exposedResults, withheldCount };
}

function withheldReceipt(base: RetrievalReceipt, count: number): RetrievalReceipt {
  return count === 0 ? base : { ...base, withheld: { ...base.withheld, count } };
}

// Interprets qmd's raw JSON hits as candidate locators. This is the part of
// retrieval that is inherently search-specific: it is the only place that
// trusts qmd's untyped output shape at all. Once a hit is validated it
// becomes a plain `{ file, score? }` candidate indistinguishable from one
// enumeration would have produced.
function validateSearchHits(parsed: unknown[], guarded: boolean): { kind: "candidates"; candidates: RetrievalCandidate[] } | { kind: "failure"; error: KnowledgeError } {
  const candidates: RetrievalCandidate[] = [];
  for (let index = 0; index < parsed.length; index++) {
    const hit = parsed[index];
    if (!isObject(hit) || typeof hit.file !== "string") {
      return { kind: "failure", error: safeForModel(retrievalError("qmd_shape_invalid", `qmd search hit ${index} must contain a file locator`, `hits[${index}].file`), guarded) };
    }
    let score: number | undefined;
    if (guarded && hit.score !== undefined) {
      if (typeof hit.score !== "number" || !Number.isFinite(hit.score)) {
        return { kind: "failure", error: safeForModel(retrievalError("qmd_shape_invalid", `qmd search hit ${index} score must be a finite number`, `hits[${index}].score`), true) };
      }
      score = hit.score;
    }
    candidates.push(score === undefined ? { file: hit.file } : { file: hit.file, score });
  }
  return { kind: "candidates", candidates };
}

// Reads the space's records root directly, sorted by filename for
// determinism, and synthesizes each entry into the same `qmd://<collection>/
// <name>.md` locator form a search hit would carry — so
// `safeRelativeMarkdownPath` containment applies identically and a symlink
// escaping the root is caught by the same realpath check `readLocatedRecord`
// already runs for search. Runs no qmd subprocess. A symlink entry is
// included as a candidate rather than filtered out here, precisely so its
// escape is caught by that shared guard rather than silently skipped.
async function enumerateCandidates(binding: ActiveSpace): Promise<{ kind: "candidates"; candidates: RetrievalCandidate[] } | { kind: "failure"; error: KnowledgeError }> {
  let entries;
  try {
    entries = await readdir(binding.recordsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { kind: "candidates", candidates: [] };
    return { kind: "failure", error: retrievalError("records_root_unavailable", `active records root could not be listed: ${error instanceof Error ? error.message : String(error)}`, "file") };
  }
  const names = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return { kind: "candidates", candidates: names.map((name) => ({ file: `qmd://${binding.qmdCollectionName}/${name}` })) };
}

export async function retrieveRelatedRecords(
  binding: ActiveSpace,
  query: string,
  spawnFn?: SpawnFn,
): Promise<RetrievalOutcome> {
  return retrieveRecords(binding, query, undefined, spawnFn);
}

export async function retrieveGuardedRecords(
  binding: ActiveSpace,
  query: string,
  filter: GuardedRetrievalFilter,
  spawnFn?: SpawnFn,
): Promise<RetrievalOutcome> {
  return retrieveRecords(binding, query, filter, spawnFn);
}

// Enumerates every Markdown record under the space's records root instead of
// running a qmd search, then feeds the SAME candidate-filtering guard
// sequence `retrieveGuardedRecords` uses. A profile view is an enumeration;
// guarded retrieval over a ranked search is not the same operation, and no
// query string can stand in for "every active record".
export async function retrieveEnumeratedRecords(
  binding: ActiveSpace,
  filter: GuardedRetrievalFilter,
): Promise<RetrievalOutcome> {
  const policyReceipt: RetrievalReceipt = {
    ...emptyReceipt(binding, null, "miss", "space"),
    requestedSourceClasses: [...filter.requestedSourceClasses],
    allowedSourceClasses: [...filter.allowedSourceClasses],
    // Enumeration never ranks, so a threshold the pack's policy declares for
    // its search-scoped views never applied to this result set. Reporting it
    // here would claim a filter that did not run.
    relevanceThreshold: null,
    withheld: { audienceId: filter.audienceId, count: 0 },
  };

  const enumerated = await enumerateCandidates(binding);
  if (enumerated.kind === "failure") {
    return { kind: "failure", errors: [safeForModel(enumerated.error, true)], receipt: policyReceipt };
  }
  if (enumerated.candidates.length === 0) return { kind: "miss", records: [], receipt: policyReceipt };

  const filtered = await filterCandidates(binding, enumerated.candidates, filter, false);
  if (filtered.kind === "failure") {
    return { kind: "failure", errors: [filtered.error], receipt: withheldReceipt(policyReceipt, filtered.withheldCount) };
  }
  const receiptWithWithheld = withheldReceipt(policyReceipt, filtered.withheldCount);
  if (filtered.records.length === 0) {
    return {
      kind: "miss",
      records: [],
      receipt: { ...receiptWithWithheld, locatorUris: filtered.locatorUris, recordIds: filtered.recordIds, exposedResults: filtered.exposedResults },
    };
  }
  return {
    kind: "hit",
    records: filtered.records,
    receipt: { ...receiptWithWithheld, kind: "hit", locatorUris: filtered.locatorUris, recordIds: filtered.recordIds, exposedResults: filtered.exposedResults },
  };
}

async function retrieveRecords(
  binding: ActiveSpace,
  query: string,
  filter: GuardedRetrievalFilter | undefined,
  spawnFn?: SpawnFn,
): Promise<RetrievalOutcome> {
  const baseReceipt = emptyReceipt(binding, query);
  const policyReceipt: RetrievalReceipt = filter === undefined
    ? baseReceipt
    : {
      ...baseReceipt,
      requestedSourceClasses: [...filter.requestedSourceClasses],
      allowedSourceClasses: [...filter.allowedSourceClasses],
      relevanceThreshold: filter.relevanceThreshold,
      withheld: { audienceId: filter.audienceId, count: 0 },
    };
  const execution = await runQmd(
    ["search", query, "--json", "-c", binding.qmdCollectionName],
    binding,
    spawnFn,
  );
  if (!execution.ranProcess) {
    return {
      kind: "failure",
      errors: [retrievalError(
        "qmd_not_run",
        filter === undefined ? `qmd search did not start: ${execution.stderr.trim().slice(0, 500)}` : "qmd search did not start",
      )],
      receipt: policyReceipt,
    };
  }
  if (execution.code !== 0) {
    return {
      kind: "failure",
      errors: [retrievalError(
        "qmd_exit",
        filter === undefined ? `qmd search exited with code ${execution.code}: ${execution.stderr.trim().slice(0, 500)}` : `qmd search exited with code ${execution.code}`,
      )],
      receipt: policyReceipt,
    };
  }
  if (execution.stdout === "No results found.\n") return { kind: "miss", records: [], receipt: policyReceipt };

  let parsed: unknown;
  try {
    parsed = JSON.parse(execution.stdout);
  } catch (error) {
    return {
      kind: "failure",
      errors: [retrievalError(
        "qmd_output_malformed",
        filter === undefined
          ? `qmd search returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`
          : "qmd search returned malformed JSON",
      )],
      receipt: policyReceipt,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      kind: "failure",
      errors: [retrievalError("qmd_shape_invalid", "qmd search JSON result must be an array")],
      receipt: policyReceipt,
    };
  }
  if (parsed.length === 0) return { kind: "miss", records: [], receipt: policyReceipt };

  const validated = validateSearchHits(parsed, filter !== undefined);
  if (validated.kind === "failure") {
    return { kind: "failure", errors: [validated.error], receipt: policyReceipt };
  }

  const filtered = await filterCandidates(binding, validated.candidates, filter, true);
  if (filtered.kind === "failure") {
    return { kind: "failure", errors: [filtered.error], receipt: withheldReceipt(policyReceipt, filtered.withheldCount) };
  }
  const receiptWithWithheld = withheldReceipt(policyReceipt, filtered.withheldCount);
  if (filtered.records.length === 0) {
    return {
      kind: "miss",
      records: [],
      receipt: { ...receiptWithWithheld, locatorUris: filtered.locatorUris, recordIds: filtered.recordIds, exposedResults: filtered.exposedResults },
    };
  }
  return {
    kind: "hit",
    records: filtered.records,
    receipt: { ...receiptWithWithheld, kind: "hit", locatorUris: filtered.locatorUris, recordIds: filtered.recordIds, exposedResults: filtered.exposedResults },
  };
}
