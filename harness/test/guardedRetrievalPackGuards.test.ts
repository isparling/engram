// Isolation tests scoped to the guards in guardedRetrievalInternal.ts /
// guardedRetrieval.ts (pack validation, request-shape guards, and the
// space-boundary guards on the retrieval read path in knowledgeRetrieval.ts,
// exercised only through guardedRetrieve). Each test constructs an input that
// violates exactly one guard and asserts the resulting error CODE by identity:
// "an input that violates exactly that guard fails with exactly that error
// code, and deleting the guard makes exactly that test fail."
//
// presentation.ts and knowledgeRetrieval.ts are read-only from here; the
// sibling `presentationGuards.test.ts` owns presentation.ts guards.

import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { guardedRetrieve, type GuardedRetrievalRequest } from "../src/guardedRetrieval.ts";
import { fictionalPack } from "../test/fictionalPack.ts";
import { registerSpace, selectSpace } from "../src/spaceRegistry.ts";
import type { PresentationPack } from "../src/knowledgeTypes.ts";
import { makeScriptedSpawnFn } from "./fakes.ts";
import {
  createEphemeralSpace,
  destroyEphemeralSpace,
  FIXTURES_DIR,
  writeLocalBindingFixture,
  type EphemeralSpace,
} from "./testSupport.ts";

const RETRIEVAL_RECORDS_DIR = join(FIXTURES_DIR, "retrieval-space", "records");
const spacesToClean: EphemeralSpace[] = [];

after(async () => {
  for (const space of spacesToClean) await destroyEphemeralSpace(space);
});

type Context = { space: EphemeralSpace; env: Record<string, string>; collection: string };

let contextNumber = 0;

async function makeContext(): Promise<Context> {
  const number = contextNumber++;
  // The retrieval-space fixture records hardcode scope.space: "fictional-space-retrieval"
  // (see harness/test-fixtures/retrieval-space/records/*.md), so every context
  // must bind that exact spaceId or every record read would spuriously
  // trip scope_space_mismatch. Matches guardedRetrieval.test.ts's makeContext.
  const spaceId = "fictional-space-retrieval";
  const space = await createEphemeralSpace(RETRIEVAL_RECORDS_DIR, `retrieval-pack-guard-${number}`);
  spacesToClean.push(space);
  const registryPath = join(space.root, "registry.json");
  const bindingPath = await writeLocalBindingFixture(space, spaceId);
  const registered = await registerSpace(registryPath, bindingPath);
  assert.equal(registered.ok, true);
  const selected = await selectSpace(registryPath, spaceId, `retrieval-pack-guard-session-${number}`);
  assert.equal(selected.ok, true);
  return {
    space,
    collection: space.binding.qmdCollectionName,
    env: {
      ENGRAM_BINDING_REGISTRY: registryPath,
      ENGRAM_HOST_SESSION_ID: `retrieval-pack-guard-session-${number}`,
    },
  };
}

function hit(collection: string, id: string, score = 0.95): { file: string; score: number } {
  return { file: `qmd://${collection}/${id}.md`, score };
}

function qmdOutput(collection: string, ids: string[], score = 0.95): string {
  return JSON.stringify(ids.map((id) => hit(collection, id, score)));
}

// Constructs a value whose STATIC type is exactly T but whose RUNTIME value
// is `runtime`. Several guards under test exist specifically for callers
// that never went through this module's TypeScript signatures at all (a
// bare JS caller, a pack loaded from disk, a subprocess boundary) — the
// same reason `guardedRetrieval.ts` treats `request.pack` as `unknown`
// before validation. Modelling that caller in a TS test file relies on a
// genuine (and narrow) unsoundness in `Object.assign`'s typing:
// intersecting a property's declared type with `unknown` leaves the
// declared type unchanged, while the JS runtime still performs an ordinary
// last-write-wins property copy. No cast keyword is used anywhere in this
// construction.
function withRuntimeValue<T>(wellTyped: T, runtime: unknown): T {
  return Object.assign({}, { value: wellTyped }, { value: runtime }).value;
}

type FailureReceiptLike = {
  receipt: {
    activeSpace: string | null;
    collection: string;
    requestedSourceClasses: readonly string[];
    allowedSourceClasses: readonly string[];
    exposedResults: readonly unknown[];
    recordIds: readonly unknown[];
    locatorUris: readonly unknown[];
  };
};

function assertWellFormedFailureReceipt(
  result: FailureReceiptLike,
  expected: {
    activeSpace: string | null;
    collection: string;
    requestedSourceClasses: readonly string[];
    allowedSourceClasses: readonly string[];
  },
): void {
  assert.equal(result.receipt.activeSpace, expected.activeSpace);
  assert.equal(result.receipt.collection, expected.collection);
  assert.deepEqual(result.receipt.requestedSourceClasses, [...expected.requestedSourceClasses]);
  assert.deepEqual(result.receipt.allowedSourceClasses, [...expected.allowedSourceClasses]);
  assert.deepEqual(result.receipt.exposedResults, []);
  assert.deepEqual(result.receipt.recordIds, []);
  assert.deepEqual(result.receipt.locatorUris, []);
}

// Every guard below fails before `retrieveGuardedRecords` produces any
// exposed results, so the failure receipt must never carry partial
// results — this is the "never claims exposed results it did not have"
// half of the acceptance criteria, checked uniformly. The receipt must
// also name the active space and policy inputs.
function assertFictionalSpaceFailureReceipt(
  result: FailureReceiptLike,
  context: Context,
  expected: {
    requestedSourceClasses: readonly string[];
    allowedSourceClasses: readonly string[];
  } = {
    requestedSourceClasses: fictionalPack.retrievalPolicy.allowedSourceClasses,
    allowedSourceClasses: fictionalPack.retrievalPolicy.allowedSourceClasses,
  },
): void {
  assertWellFormedFailureReceipt(result, {
    activeSpace: "fictional-space-retrieval",
    collection: context.collection,
    requestedSourceClasses: expected.requestedSourceClasses,
    allowedSourceClasses: expected.allowedSourceClasses,
  });
}

// ---------------------------------------------------------------------------
// validatePack — the three split policy-defect codes.
// ---------------------------------------------------------------------------

test("guard: policy_presentations_included — a pack whose retrieval policy declares includePresentations true", async () => {
  const context = await makeContext();
  const hostilePack: PresentationPack = {
    ...fictionalPack,
    retrievalPolicy: {
      ...fictionalPack.retrievalPolicy,
      includePresentations: withRuntimeValue<false>(false, true),
    },
  };
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]);
  const result = await guardedRetrieve({ query: "synthetic status", audienceId: "peer", pack: hostilePack }, { env: context.env, spawnFn: scripted.spawnFn });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["policy_presentations_included"]);
  assert.equal(scripted.calls.length, 0, "a policy defect is refused before any qmd call");
  assertFictionalSpaceFailureReceipt(result, context);
});

test("guard: policy_source_classes_empty — a pack whose retrieval policy allows zero source classes", async () => {
  const context = await makeContext();
  const hostilePack: PresentationPack = {
    ...fictionalPack,
    retrievalPolicy: { ...fictionalPack.retrievalPolicy, allowedSourceClasses: [] },
  };
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]);
  const result = await guardedRetrieve({ query: "synthetic status", audienceId: "peer", pack: hostilePack }, { env: context.env, spawnFn: scripted.spawnFn });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["policy_source_classes_empty"]);
  assert.equal(scripted.calls.length, 0, "a policy defect is refused before any qmd call");
  assertFictionalSpaceFailureReceipt(result, context, { requestedSourceClasses: [], allowedSourceClasses: [] });
});

test("guard: policy_relevance_threshold_invalid — a pack whose relevance threshold is negative", async () => {
  const context = await makeContext();
  const hostilePack: PresentationPack = {
    ...fictionalPack,
    retrievalPolicy: { ...fictionalPack.retrievalPolicy, relevanceThreshold: -0.1 },
  };
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]);
  const result = await guardedRetrieve({ query: "synthetic status", audienceId: "peer", pack: hostilePack }, { env: context.env, spawnFn: scripted.spawnFn });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["policy_relevance_threshold_invalid"]);
  assert.equal(scripted.calls.length, 0, "a policy defect is refused before any qmd call");
  assertFictionalSpaceFailureReceipt(result, context);
});

// ---------------------------------------------------------------------------
// Request-shape guards checked before any qmd call.
// ---------------------------------------------------------------------------

test("guard: pack_not_installed — a pack id/version absent from the active space's installed packs", async () => {
  const context = await makeContext();
  const uninstalledPack: PresentationPack = { ...fictionalPack, version: "9.9.9" };
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]);
  const result = await guardedRetrieve({ query: "synthetic status", audienceId: "peer", pack: uninstalledPack }, { env: context.env, spawnFn: scripted.spawnFn });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["pack_not_installed"]);
  assert.equal(scripted.calls.length, 0);
  assertFictionalSpaceFailureReceipt(result, context);
});

test("guard: query_invalid — an empty, whitespace-only, NUL-containing, or non-string query never reaches qmd", async () => {
  const context = await makeContext();
  const stringCases: Array<{ label: string; query: string }> = [
    { label: "empty string", query: "" },
    { label: "whitespace-only", query: "   " },
    { label: "NUL byte", query: "syn\u0000thetic" },
  ];
  for (const testCase of stringCases) {
    const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]);
    const result = await guardedRetrieve({ query: testCase.query, audienceId: "peer", pack: fictionalPack }, { env: context.env, spawnFn: scripted.spawnFn });
    assert.equal(result.status, "failed", testCase.label);
    if (result.status !== "failed") continue;
    assert.deepEqual(result.errors.map((error) => error.code), ["query_invalid"], testCase.label);
    assert.equal(scripted.calls.length, 0, testCase.label);
    assertFictionalSpaceFailureReceipt(result, context);
  }

  const nonStringRequest: GuardedRetrievalRequest = {
    query: withRuntimeValue<string>("placeholder", 42),
    audienceId: "peer",
    pack: fictionalPack,
  };
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]);
  const result = await guardedRetrieve(nonStringRequest, { env: context.env, spawnFn: scripted.spawnFn });
  assert.equal(result.status, "failed", "non-string query");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["query_invalid"], "non-string query");
  assert.equal(scripted.calls.length, 0, "non-string query");
  assertFictionalSpaceFailureReceipt(result, context);
});

test("guard: audience_unknown — an audienceId not configured by the pack", async () => {
  const context = await makeContext();
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]);
  const result = await guardedRetrieve({ query: "synthetic status", audienceId: "unregistered-audience", pack: fictionalPack }, { env: context.env, spawnFn: scripted.spawnFn });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["audience_unknown"]);
  assert.equal(scripted.calls.length, 0);
  assertFictionalSpaceFailureReceipt(result, context);
});

test("guard: source_class_not_allowed — a requested source class outside the retrieval policy's allowed classes", async () => {
  const context = await makeContext();
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]);
  const result = await guardedRetrieve(
    { query: "synthetic status", audienceId: "peer", requestedSourceClasses: ["not-a-configured-class"], pack: fictionalPack },
    { env: context.env, spawnFn: scripted.spawnFn },
  );
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["source_class_not_allowed"]);
  assert.equal(scripted.calls.length, 0);
  assertFictionalSpaceFailureReceipt(result, context, {
    requestedSourceClasses: ["not-a-configured-class"],
    allowedSourceClasses: fictionalPack.retrievalPolicy.allowedSourceClasses,
  });
});

test("guard: query_strategy_failed — a pack queryStrategy that throws", async () => {
  const context = await makeContext();
  const throwingPack: PresentationPack = {
    ...fictionalPack,
    retrievalPolicy: {
      ...fictionalPack.retrievalPolicy,
      queryStrategy: () => {
        throw new Error("synthetic strategy failure");
      },
    },
  };
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]);
  const result = await guardedRetrieve({ query: "synthetic status", audienceId: "peer", pack: throwingPack }, { env: context.env, spawnFn: scripted.spawnFn });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["query_strategy_failed"]);
  assert.equal(scripted.calls.length, 0);
  assertFictionalSpaceFailureReceipt(result, context);
});

test("guard: query_strategy_invalid — a pack queryStrategy returning an empty, whitespace-only, NUL-containing, or non-string query", async () => {
  const context = await makeContext();
  const stringCases: Array<{ label: string; queryStrategy: () => string }> = [
    { label: "empty string", queryStrategy: () => "" },
    { label: "whitespace-only", queryStrategy: () => "   " },
    { label: "NUL byte", queryStrategy: () => "syn\u0000thetic" },
  ];
  for (const testCase of stringCases) {
    const hostilePack: PresentationPack = {
      ...fictionalPack,
      retrievalPolicy: { ...fictionalPack.retrievalPolicy, queryStrategy: testCase.queryStrategy },
    };
    const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]);
    const result = await guardedRetrieve({ query: "synthetic status", audienceId: "peer", pack: hostilePack }, { env: context.env, spawnFn: scripted.spawnFn });
    assert.equal(result.status, "failed", testCase.label);
    if (result.status !== "failed") continue;
    assert.deepEqual(result.errors.map((error) => error.code), ["query_strategy_invalid"], testCase.label);
    assert.equal(scripted.calls.length, 0, testCase.label);
    assertFictionalSpaceFailureReceipt(result, context);
  }

  const numericStrategy = (): number => 7;
  const nonStringPack: PresentationPack = {
    ...fictionalPack,
    retrievalPolicy: {
      ...fictionalPack.retrievalPolicy,
      queryStrategy: withRuntimeValue<PresentationPack["retrievalPolicy"]["queryStrategy"]>(
        fictionalPack.retrievalPolicy.queryStrategy,
        numericStrategy,
      ),
    },
  };
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]);
  const result = await guardedRetrieve({ query: "synthetic status", audienceId: "peer", pack: nonStringPack }, { env: context.env, spawnFn: scripted.spawnFn });
  assert.equal(result.status, "failed", "non-string strategy result");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["query_strategy_invalid"], "non-string strategy result");
  assert.equal(scripted.calls.length, 0, "non-string strategy result");
  assertFictionalSpaceFailureReceipt(result, context);
});

// receipt_incomplete (guardedRetrievalInternal.ts:192, checked after the
// guard-split above) has no test here: it is a FINDING, not a covered
// guard. `retrieveGuardedRecords` (knowledgeRetrieval.ts) builds
// `receipt.exposedResults` and the returned `records` array in the SAME
// loop iteration, keyed by the SAME `located.value.record.id`, and
// deduplicates qmd hits by resolved path before that loop runs at all —
// every accepted record is pushed to both arrays together, with an
// identical `recordId`, and can never diverge. No qmd response, however
// hostile, can make a record appear in `retrieval.records` without a
// matching entry in `retrieval.receipt.exposedResults`. A test asserting
// `receipt_incomplete` would necessarily be vacuous (it could only ever pass
// by never triggering the code at all), so no such test is written.

// ---------------------------------------------------------------------------
// active_space_unresolved — through guardedRetrieve, not guardedRetrieveInActiveSpace.
// ---------------------------------------------------------------------------

test("guard: active_space_unresolved — guardedRetrieve when the environment resolves no active space", async () => {
  const result = await guardedRetrieve(
    { query: "synthetic status", audienceId: "peer", pack: fictionalPack },
    { env: { ENGRAM_BINDING_REGISTRY: "/nonexistent/synthetic-registry.json" } },
  );
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["active_space_unresolved"]);
  assertWellFormedFailureReceipt(result, {
    activeSpace: null,
    collection: "",
    requestedSourceClasses: [],
    allowedSourceClasses: fictionalPack.retrievalPolicy.allowedSourceClasses,
  });
});

// ---------------------------------------------------------------------------
// Space-boundary codes on the retrieval read path (knowledgeRetrieval.ts,
// exercised only through guardedRetrieve — that file itself is not edited).
// ---------------------------------------------------------------------------

test("guard: foreign_locator — a qmd hit naming a collection other than the active one", async () => {
  const context = await makeContext();
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: JSON.stringify([{ file: "qmd://a-sibling-collection/status-brief.md", score: 0.99 }]) }]);
  const result = await guardedRetrieve({ query: "synthetic status", audienceId: "peer", pack: fictionalPack }, { env: context.env, spawnFn: scripted.spawnFn });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["foreign_locator"]);
  assert.equal(scripted.calls.length, 1);
  assertFictionalSpaceFailureReceipt(result, context);
});

// FINDING: backslash separators, percent-encoding, and a leading-slash
// "absolute path" all collapse to the SAME code, `locator_invalid`, in
// `safeRelativeMarkdownPath` (knowledgeRetrieval.ts). The function's first
// guard clause rejects a relative path containing "\\", "%", NUL, or a
// leading "/" together as one check, before the later `locator_escape`
// clause (which separately re-checks `posix.isAbsolute`) ever runs. An
// absolute-path locator therefore can never reach — and never exercise —
// the `posix.isAbsolute` branch of the escape check; it is dead code
// reachable only by first satisfying the earlier "no leading slash"
// rejection, which is impossible for an absolute path by definition. The
// three scenarios below are message-distinguishable but NOT
// code-distinguishable.
test("guard: locator_invalid — a backslash separator, percent-encoding, and a leading-slash path all reach the same code", async () => {
  const context = await makeContext();
  const hostileLocators: Array<{ label: string; file: string }> = [
    { label: "backslash separator", file: `qmd://${context.collection}/sub\\status-brief.md` },
    { label: "percent-encoding", file: `qmd://${context.collection}/status%2Dbrief.md` },
    { label: "absolute path", file: `qmd://${context.collection}//etc/status-brief.md` },
  ];
  for (const hostile of hostileLocators) {
    const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: JSON.stringify([{ file: hostile.file, score: 0.99 }]) }]);
    const result = await guardedRetrieve({ query: "synthetic status", audienceId: "peer", pack: fictionalPack }, { env: context.env, spawnFn: scripted.spawnFn });
    assert.equal(result.status, "failed", hostile.label);
    if (result.status !== "failed") continue;
    assert.deepEqual(result.errors.map((error) => error.code), ["locator_invalid"], hostile.label);
    assertFictionalSpaceFailureReceipt(result, context);
  }
});

test("guard: locator_escape — a qmd hit locator with an unnormalized .. segment", async () => {
  const context = await makeContext();
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: JSON.stringify([{ file: `qmd://${context.collection}/subdir/../status-brief.md`, score: 0.99 }]) }]);
  const result = await guardedRetrieve({ query: "synthetic status", audienceId: "peer", pack: fictionalPack }, { env: context.env, spawnFn: scripted.spawnFn });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["locator_escape"]);
  assertFictionalSpaceFailureReceipt(result, context);
});

test("guard: path_escape — a record file, reached by an in-collection symlink, that resolves outside the active records root", async () => {
  const context = await makeContext();
  const outsideTarget = join(context.space.root, "outside-records-root.md");
  await writeFile(outsideTarget, "synthetic content outside the records root, never read: path_escape fires before parsing", "utf8");
  await symlink(outsideTarget, join(context.space.binding.recordsRoot, "escape-link.md"));
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: JSON.stringify([{ file: `qmd://${context.collection}/escape-link.md`, score: 0.99 }]) }]);
  const result = await guardedRetrieve({ query: "synthetic status", audienceId: "peer", pack: fictionalPack }, { env: context.env, spawnFn: scripted.spawnFn });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["path_escape"]);
  assertFictionalSpaceFailureReceipt(result, context);
});

test("guard: scope_space_mismatch — a record whose scope.space names a different space than the active one", async () => {
  const context = await makeContext();
  const recordPath = join(context.space.binding.recordsRoot, "foreign-scope.md");
  await writeFile(
    recordPath,
    [
      "---",
      "schema_version: 0",
      'id: "foreign-scope"',
      'kind: "claim"',
      'status: "active"',
      'statement: "A synthetic record scoped to a different space."',
      'details: {"basis":"synthetic-status","certainty":"high","audience":"shared","priority":"baseline"}',
      'scope: {"space":"a-different-synthetic-space","subjects":["subject:beacon"],"topics":["topic:delivery"],"contexts":["context:review-alpha"],"dimensions":{"visibility":["shared"]}}',
      'pack: {"id":"fictional-integrity","version":"0.1.0"}',
      'sources: [{"type":"status","ref":"source:beacon-status"}]',
      'session: {"id":"synthetic-session-retrieval","host":"synthetic-host"}',
      'submitted_at: "2026-08-05"',
      'disposition: "new"',
      'relationships: {"supports":[],"contradicts":[],"refines":[],"supersedes":[]}',
      "history: []",
      "---",
      "## Statement",
      "",
      "A synthetic record scoped to a different space.",
      "",
    ].join("\n"),
    "utf8",
  );
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: JSON.stringify([{ file: `qmd://${context.collection}/foreign-scope.md`, score: 0.99 }]) }]);
  const result = await guardedRetrieve({ query: "synthetic status", audienceId: "peer", pack: fictionalPack }, { env: context.env, spawnFn: scripted.spawnFn });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["scope_space_mismatch"]);
  assertFictionalSpaceFailureReceipt(result, context);
});

test("guard: authorization_policy_invalid — authorize must return a boolean before any record is exposed", async () => {
  const context = await makeContext();
  const pack: PresentationPack = {
    ...fictionalPack,
    audiences: [{
      id: "non-boolean-authorizer",
      version: 1,
      authorize: () => withRuntimeValue(true, "truthy but not boolean"),
      adapt: ({ projection }) => ({
        title: projection.title,
        summary: projection.summary,
        facts: [...projection.facts],
        uncertainty: [...projection.uncertainty],
        actions: [...projection.actions],
        recommendationIds: [...projection.recommendationIds],
      }),
    }],
  };
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["restricted-note"]) }]);
  const result = await guardedRetrieve(
    { query: "beacon", audienceId: "non-boolean-authorizer", pack },
    { env: context.env, spawnFn: scripted.spawnFn },
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.errors[0]?.code, "authorization_policy_invalid");
  assert.deepEqual(result.receipt.exposedResults, []);
});

test("guard: policy_shape_invalid — a malformed pack on the active-space path fails structurally instead of throwing", async () => {
  const context = await makeContext();
  const malformedPack = withRuntimeValue<PresentationPack>(
    fictionalPack,
    { id: "fictional-integrity", version: "0.1.0" },
  );
  const result = await guardedRetrieve(
    { query: "beacon", audienceId: "peer", pack: malformedPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([]).spawnFn },
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.errors[0]?.code, "policy_shape_invalid");
  assert.equal(result.receipt.activeSpace, "fictional-space-retrieval");
  assert.deepEqual(result.receipt.allowedSourceClasses, []);
});

test("guard: retrieval policy and audience authorization are snapshotted before queryStrategy can mutate them", async () => {
  const context = await makeContext();
  const audience = {
    id: "mutated-authorizer",
    version: 1,
    authorize: (): boolean => false,
    adapt: ({ projection }) => ({
      title: projection.title,
      summary: projection.summary,
      facts: [...projection.facts],
      uncertainty: [...projection.uncertainty],
      actions: [...projection.actions],
      recommendationIds: [...projection.recommendationIds],
    }),
  } satisfies PresentationPack["audiences"][number];
  const pack: PresentationPack = {
    ...fictionalPack,
    audiences: [audience],
    retrievalPolicy: {
      ...fictionalPack.retrievalPolicy,
      queryStrategy: ({ query }) => {
        audience.authorize = () => true;
        return query;
      },
    },
  };
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["restricted-note"]) }]);
  const result = await guardedRetrieve(
    { query: "beacon", audienceId: "mutated-authorizer", pack },
    { env: context.env, spawnFn: scripted.spawnFn },
  );

  assert.equal(result.status, "miss");
  if (result.status !== "miss") return;
  assert.equal(result.receipt.withheld.count, 1);
  assert.deepEqual(result.receipt.exposedResults, []);
});
