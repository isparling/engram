// Isolation tests: presentation.ts declares roughly fifty distinct error
// codes and guardedRetrieval.test.ts asserts almost none of them by identity — a
// render that fails for the wrong reason satisfies `status === "failed"` just
// as well as one that fails for the right one.
//
// Every test below builds a synthetic PresentationPack whose view, audience,
// and delivery are engineered to violate exactly one guard in
// `validateProjection`, `validateAdaptation`, or `renderPresentation`'s own
// request/definition checks, reaching that guard and no earlier one. Each
// failure is asserted by error code (and field, where the same code covers
// several fields) rather than by `status` alone.
//
// Per CLAUDE.md rule 1, each guard here was independently confirmed by
// neutering the guard's line in presentation.ts, running ONLY this file,
// observing exactly the expected test(s) fail, then restoring the guard and
// confirming green. That observation is reported in the delivering message,
// not encoded here.
//
// This file owns presentation.ts. It must not edit guardedRetrieval.ts,
// guardedRetrievalInternal.ts, or guardedRetrieval.test.ts.

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  renderPresentation,
  type PresentationFailure,
  type PresentationOutcome,
  type PresentationPack,
  type PresentationRequest,
} from "../src/presentation.ts";
import { fictionalPack } from "../test/fictionalPack.ts";
import { registerSpace, selectSpace } from "../src/spaceRegistry.ts";
import type {
  AudienceDefinition,
  DeliveryDefinition,
  KnowledgeError,
  PresentationDraft,
  SemanticProjection,
  SourceClassPolicy,
  ViewDefinition,
} from "../src/knowledgeTypes.ts";
import { makeScriptedSpawnFn } from "./fakes.ts";
import type { SpawnFn } from "../src/qmdRunner.ts";
import {
  createEphemeralSpace,
  destroyEphemeralSpace,
  FIXTURES_DIR,
  writeLocalBindingFixture,
  type EphemeralSpace,
} from "./testSupport.ts";

// A private fixture directory, not the shared test-fixtures/retrieval-space/ that
// guardedRetrieval.test.ts and the PackGuards suite use, so this file cannot
// collide with either. It carries one record the shared fixtures do not:
// a `kind: "recommendation"` record whose status is not "active"
// (recommendation-contested.md). The shared pack's `isEligible` policy
// filters non-active records out of retrieval entirely, so there is no way
// to construct "cited a retrieved recommendation that is not active"
// without either a non-active recommendation-kind fixture or a policy
// override; several tests below use both together.
const PRESENTATION_GUARD_RECORDS_DIR = join(FIXTURES_DIR, "presentation-guard-space", "records");
const SPACE_ID = "fictional-space-retrieval";
const VALID_MODEL = "fictional-provider/fictional-model";
const spacesToClean: EphemeralSpace[] = [];

after(async () => {
  for (const space of spacesToClean) await destroyEphemeralSpace(space);
});

type Context = {
  space: EphemeralSpace;
  env: Record<string, string>;
  collection: string;
};

let contextNumber = 0;

async function makeContext(): Promise<Context> {
  const number = contextNumber++;
  const space = await createEphemeralSpace(PRESENTATION_GUARD_RECORDS_DIR, `presentation-guard-space-${number}`);
  spacesToClean.push(space);
  const registryPath = join(space.root, "registry.json");
  const bindingPath = await writeLocalBindingFixture(space, SPACE_ID);
  const registered = await registerSpace(registryPath, bindingPath);
  assert.equal(registered.ok, true);
  const sessionId = `presentation-guard-session-${number}`;
  const selected = await selectSpace(registryPath, SPACE_ID, sessionId);
  assert.equal(selected.ok, true);
  return {
    space,
    collection: space.binding.qmdCollectionName,
    env: { ENGRAM_BINDING_REGISTRY: registryPath, ENGRAM_HOST_SESSION_ID: sessionId },
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A context whose space additionally authorizes `.engram-presentations` as a
 * write root, so a delivery that declares `retain: true` clears the
 * retention boundary check and reaches the guard under test. Only the
 * delivery_limit_exceeded test needs this: every other test declares
 * `retain: false`, so the retention machinery never runs for it and "no
 * artifact was written" holds structurally, not just by assertion.
 */
async function makeRetentionContext(): Promise<{ context: Context; presentationRoot: string }> {
  const number = contextNumber++;
  const space = await createEphemeralSpace(PRESENTATION_GUARD_RECORDS_DIR, `presentation-guard-retain-${number}`);
  spacesToClean.push(space);
  const presentationRoot = join(space.root, ".engram-presentations");
  await mkdir(presentationRoot, { recursive: true });
  const bindingPath = await writeLocalBindingFixture(space, SPACE_ID);
  const bindingValue: unknown = JSON.parse(await readFile(bindingPath, "utf8"));
  if (!isJsonObject(bindingValue)) throw new Error("synthetic local binding is not an object");
  bindingValue.write_roots = [space.binding.recordsRoot, presentationRoot];
  await writeFile(bindingPath, JSON.stringify(bindingValue), "utf8");
  const registryPath = join(space.root, "registry.json");
  const registered = await registerSpace(registryPath, bindingPath);
  assert.equal(registered.ok, true);
  const sessionId = `presentation-guard-retain-session-${number}`;
  const selected = await selectSpace(registryPath, SPACE_ID, sessionId);
  assert.equal(selected.ok, true);
  return {
    context: {
      space,
      collection: space.binding.qmdCollectionName,
      env: { ENGRAM_BINDING_REGISTRY: registryPath, ENGRAM_HOST_SESSION_ID: sessionId },
    },
    presentationRoot,
  };
}

function hit(collection: string, id: string, score = 0.95): { file: string; score: number } {
  return { file: `qmd://${collection}/${id}.md`, score };
}

function qmdOutput(collection: string, ids: string[], score = 0.95): string {
  return JSON.stringify(ids.map((id) => hit(collection, id, score)));
}

/** A scripted qmd search returning exactly `ids` from `collection`. */
function scriptedSpawn(collection: string, ids: string[]): SpawnFn {
  return makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(collection, ids) }]).spawnFn;
}

// ---------------------------------------------------------------------------
// Synthetic pack scaffolding. Every guard test starts from a projection and
// draft that are valid on every axis, then overrides exactly the one field
// that violates the guard under test, so the resulting failure cannot be
// explained by any other guard.

function cleanProjection(): SemanticProjection {
  return {
    title: "Valid synthetic title",
    summary: "Valid synthetic summary.",
    facts: ["Fact A.", "Fact B."],
    requiredFacts: ["Fact A."],
    uncertainty: ["Uncertainty A."],
    actions: [],
    recommendationIds: [],
  };
}

function cleanDraftFrom(projection: SemanticProjection): PresentationDraft {
  return {
    title: "Valid synthetic audience title",
    summary: "Valid synthetic audience summary.",
    facts: [...projection.facts],
    uncertainty: [...projection.uncertainty],
    actions: [...projection.actions],
    recommendationIds: [...projection.recommendationIds],
  };
}

function makeView(overrides: Partial<ViewDefinition> = {}): ViewDefinition {
  return {
    id: "guard-view",
    version: 1,
    scope: "search",
    retrievalQuery: () => "beacon",
    project: () => cleanProjection(),
    ...overrides,
  };
}

function makeAudience(overrides: Partial<AudienceDefinition> = {}): AudienceDefinition {
  return {
    id: "guard-audience",
    version: 1,
    authorize: () => true,
    adapt: ({ projection }) => cleanDraftFrom(projection),
    ...overrides,
  };
}

function makeDelivery(overrides: Partial<DeliveryDefinition> = {}): DeliveryDefinition {
  return {
    id: "guard-delivery",
    version: 1,
    format: "plain",
    maxWords: 500,
    retain: false,
    ...overrides,
  };
}

function makePack(options: {
  view?: ViewDefinition;
  audience?: AudienceDefinition;
  delivery?: DeliveryDefinition;
  packOverrides?: Partial<PresentationPack>;
  policyOverrides?: Partial<SourceClassPolicy>;
} = {}): PresentationPack {
  return {
    ...fictionalPack,
    retrievalPolicy: { ...fictionalPack.retrievalPolicy, ...options.policyOverrides },
    views: [options.view ?? makeView()],
    audiences: [options.audience ?? makeAudience()],
    deliveries: [options.delivery ?? makeDelivery()],
    ...options.packOverrides,
  };
}

function baseRequest(pack: PresentationPack, overrides: Partial<PresentationRequest> = {}): PresentationRequest {
  const view = pack.views[0];
  const audience = pack.audiences[0];
  const delivery = pack.deliveries[0];
  if (view === undefined || audience === undefined || delivery === undefined) {
    throw new Error("synthetic pack under test must declare exactly one view, audience, and delivery");
  }
  return {
    viewId: view.id,
    audienceId: audience.id,
    deliveryId: delivery.id,
    model: VALID_MODEL,
    pack,
    generatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function withRuntimeValue<T>(wellTyped: T, runtime: unknown): T {
  return Object.assign({}, { value: wellTyped }, { value: runtime }).value;
}

// ---------------------------------------------------------------------------
// Assertion helpers.
function failed(result: PresentationOutcome): PresentationFailure {
  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected a failed presentation");
  // PresentationSuccess and PresentationFailure are structurally disjoint —
  // "content" and "receipt" only exist on success — but assert it directly
  // too, since the property under review is exactly "a failure must carry
  // no partial success", not just a status string.
  assert.equal("content" in result, false, "a failed presentation must carry no rendered content");
  assert.equal("receipt" in result, false, "a failed presentation must carry no presentation receipt");
  return result;
}

function assertOnlyError(result: PresentationFailure, code: string, field?: string, kind?: KnowledgeError["kind"]): void {
  assert.equal(result.errors.length, 1, `expected exactly one error, got ${JSON.stringify(result.errors)}`);
  const error = result.errors[0];
  if (error === undefined) throw new Error("unreachable: errors.length was just asserted to be 1");
  assert.equal(error.code, code);
  if (field !== undefined) assert.equal(error.field, field);
  if (kind !== undefined) assert.equal(error.kind, kind);
}

async function assertNoPresentationArtifact(space: EphemeralSpace): Promise<void> {
  const entries = await readdir(join(space.root, ".engram-presentations")).catch(() => []);
  assert.deepEqual(entries, [], "no presentation artifact should have been written");
}

// ===========================================================================
// renderPresentation request/definition guards, in the order they run.

test("guard: pack_not_installed — a request pack version that does not match the active space's installed pack", async () => {
  const context = await makeContext();
  const pack = makePack({ packOverrides: { version: "9.9.9" } });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "pack_not_installed", "pack", "authorization");
  await assertNoPresentationArtifact(context.space);
});

test("guard: model_not_allowed — a request model absent from the active space's allowed models", async () => {
  const context = await makeContext();
  const pack = makePack();
  const result = failed(
    await renderPresentation(baseRequest(pack, { model: "not-a-fictional-model" }), {
      env: context.env,
      spawnFn: scriptedSpawn(context.collection, ["status-brief"]),
    }),
  );
  assertOnlyError(result, "model_not_allowed", "model");
  await assertNoPresentationArtifact(context.space);
});

test("guard: view_unknown — a request viewId absent from the pack's declared views", async () => {
  const context = await makeContext();
  const pack = makePack();
  const result = failed(
    await renderPresentation(baseRequest(pack, { viewId: "no-such-view" }), {
      env: context.env,
      spawnFn: scriptedSpawn(context.collection, ["status-brief"]),
    }),
  );
  assertOnlyError(result, "view_unknown", "viewId");
  await assertNoPresentationArtifact(context.space);
});

test("guard: audience_unknown — a request audienceId absent from the pack's declared audiences", async () => {
  const context = await makeContext();
  const pack = makePack();
  const result = failed(
    await renderPresentation(baseRequest(pack, { audienceId: "no-such-audience" }), {
      env: context.env,
      spawnFn: scriptedSpawn(context.collection, ["status-brief"]),
    }),
  );
  assertOnlyError(result, "audience_unknown", "audienceId");
  await assertNoPresentationArtifact(context.space);
});

test("guard: delivery_unknown — a request deliveryId absent from the pack's declared deliveries", async () => {
  const context = await makeContext();
  const pack = makePack();
  const result = failed(
    await renderPresentation(baseRequest(pack, { deliveryId: "no-such-delivery" }), {
      env: context.env,
      spawnFn: scriptedSpawn(context.collection, ["status-brief"]),
    }),
  );
  assertOnlyError(result, "delivery_unknown", "deliveryId");
  await assertNoPresentationArtifact(context.space);
});

test("guard: definition_version_invalid — a negative view version", async () => {
  const context = await makeContext();
  const pack = makePack({ view: makeView({ version: -1 }) });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "definition_version_invalid");
  await assertNoPresentationArtifact(context.space);
});

test("guard: definition_version_invalid — a non-integer audience version", async () => {
  const context = await makeContext();
  const pack = makePack({ audience: makeAudience({ version: 1.5 }) });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "definition_version_invalid");
  await assertNoPresentationArtifact(context.space);
});

test("guard: delivery_constraint_invalid — a non-positive delivery maxWords", async () => {
  const context = await makeContext();
  const pack = makePack({ delivery: makeDelivery({ maxWords: 0 }) });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "delivery_constraint_invalid", "deliveryId");
  await assertNoPresentationArtifact(context.space);
});

test("guard: generated_at_invalid — a request generatedAt that is not an ISO-like timestamp", async () => {
  const context = await makeContext();
  const pack = makePack();
  const result = failed(
    await renderPresentation(baseRequest(pack, { generatedAt: "not-a-real-timestamp" }), {
      env: context.env,
      spawnFn: scriptedSpawn(context.collection, ["status-brief"]),
    }),
  );
  assertOnlyError(result, "generated_at_invalid", "generatedAt");
  await assertNoPresentationArtifact(context.space);
});

test("guard: view_query_failed — a view whose retrievalQuery throws", async () => {
  const context = await makeContext();
  const pack = makePack({
    view: makeView({
      retrievalQuery: () => {
        throw new Error("synthetic retrieval query failure");
      },
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "view_query_failed");
  await assertNoPresentationArtifact(context.space);
});

test("guard: retrieval_miss — qmd returns no eligible current records, and the failure states a miss is not evidence of absence", async () => {
  const context = await makeContext();
  const pack = makePack();
  const result = failed(
    await renderPresentation(baseRequest(pack), {
      env: context.env,
      spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "No results found.\n" }]).spawnFn,
    }),
  );
  assertOnlyError(result, "retrieval_miss", "query");
  const [error] = result.errors;
  if (error === undefined) throw new Error("unreachable");
  assert.match(error.message, /a miss is not evidence of absence/);
  assert.equal(result.retrieval?.kind, "miss");
  await assertNoPresentationArtifact(context.space);
});

test("guard: view_projection_failed — a view whose project throws", async () => {
  const context = await makeContext();
  const pack = makePack({
    view: makeView({
      project: () => {
        throw new Error("synthetic projection failure");
      },
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "view_projection_failed");
  await assertNoPresentationArtifact(context.space);
});

test("guard: audience_adaptation_failed — an audience whose adapt throws", async () => {
  const context = await makeContext();
  const pack = makePack({
    audience: makeAudience({
      adapt: () => {
        throw new Error("synthetic adaptation failure");
      },
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "audience_adaptation_failed");
  await assertNoPresentationArtifact(context.space);
});

test("guard: delivery_limit_exceeded — an honest render over a tight maxWords limit is refused and writes no retained artifact", async () => {
  // delivery.retain is true here specifically so the "no artifact written"
  // half of the assertion is meaningful: the write boundary is authorized
  // (see makeRetentionContext), so if this guard did not fire first the
  // render would proceed to actually retain something.
  const { context, presentationRoot } = await makeRetentionContext();
  const pack = makePack({ delivery: makeDelivery({ maxWords: 1, retain: true }) });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "delivery_limit_exceeded", "deliveryId");
  assert.deepEqual(await readdir(presentationRoot), [], "delivery_limit_exceeded must fire before any retained write");
});

// ===========================================================================
// validateProjection guards.

test("guard: text_empty — an empty view.title", async () => {
  const context = await makeContext();
  const pack = makePack({ view: makeView({ project: () => ({ ...cleanProjection(), title: "" }) }) });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "text_empty", "view.title");
  await assertNoPresentationArtifact(context.space);
});

test("guard: text_empty — an empty view.summary", async () => {
  const context = await makeContext();
  const pack = makePack({ view: makeView({ project: () => ({ ...cleanProjection(), summary: "" }) }) });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "text_empty", "view.summary");
  await assertNoPresentationArtifact(context.space);
});

test("guard: text_empty — an empty entry in the view.uncertainty list", async () => {
  const context = await makeContext();
  const pack = makePack({ view: makeView({ project: () => ({ ...cleanProjection(), uncertainty: [""] }) }) });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "text_empty", "view.uncertainty");
  await assertNoPresentationArtifact(context.space);
});

test("guard: text_multiline — a multi-line view.title", async () => {
  const context = await makeContext();
  const pack = makePack({ view: makeView({ project: () => ({ ...cleanProjection(), title: "Line one\nLine two" }) }) });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "text_multiline", "view.title");
  await assertNoPresentationArtifact(context.space);
});

test("guard: text_multiline — a multi-line entry in the view.facts list", async () => {
  const context = await makeContext();
  const pack = makePack({
    view: makeView({ project: () => ({ ...cleanProjection(), facts: ["Fact A.", "A multi\nline fact."] }) }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "text_multiline", "view.facts");
  await assertNoPresentationArtifact(context.space);
});

test("guard: required_fact_missing — a view.requiredFacts entry absent from view.facts", async () => {
  const context = await makeContext();
  const pack = makePack({
    view: makeView({
      project: () => ({ ...cleanProjection(), facts: ["Fact A.", "Fact B."], requiredFacts: ["Fact A.", "Fact Z. is not projected."] }),
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "required_fact_missing");
  await assertNoPresentationArtifact(context.space);
});

test("guard: recommendation_invalid — a projection recommendationId absent from the retrieved records", async () => {
  const context = await makeContext();
  // inactive-note.md is filtered out by the default `isEligible` policy
  // (status must be "active"), so citing it lands in exactly this case: the
  // id is simply not among the retrieved records, distinct from the "present
  // but wrong kind/status" cases below.
  const pack = makePack({
    view: makeView({ project: () => ({ ...cleanProjection(), recommendationIds: ["inactive-note"] }) }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), {
      env: context.env,
      spawnFn: scriptedSpawn(context.collection, ["status-brief", "inactive-note"]),
    }),
  );
  assertOnlyError(result, "recommendation_invalid", "recommendationIds");
  await assertNoPresentationArtifact(context.space);
});

test("guard: recommendation_invalid — a projection recommendationId that names a retrieved non-recommendation record", async () => {
  const context = await makeContext();
  const pack = makePack({
    view: makeView({ project: () => ({ ...cleanProjection(), recommendationIds: ["status-brief"] }) }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "recommendation_invalid", "recommendationIds");
  await assertNoPresentationArtifact(context.space);
});

test("guard: recommendation_invalid — a projection recommendationId that names a retrieved but inactive recommendation record", async () => {
  const context = await makeContext();
  // isEligible is overridden to admit every status, purely to get a
  // non-active recommendation record into `records` at all — the shared
  // fictionalPack policy would otherwise filter recommendation-contested.md
  // (status "contested") out before this guard is ever reached.
  const pack = makePack({
    view: makeView({ project: () => ({ ...cleanProjection(), recommendationIds: ["recommendation-contested"] }) }),
    policyOverrides: { isEligible: () => true },
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), {
      env: context.env,
      spawnFn: scriptedSpawn(context.collection, ["recommendation-contested"]),
    }),
  );
  assertOnlyError(result, "recommendation_invalid", "recommendationIds");
  await assertNoPresentationArtifact(context.space);
});

// ===========================================================================
// validateAdaptation guards.

test("guard: fact_not_in_view — an audience fact absent from the view's projected facts", async () => {
  const context = await makeContext();
  const pack = makePack({
    audience: makeAudience({
      adapt: ({ projection }) => ({ ...cleanDraftFrom(projection), facts: [...projection.facts, "An extraneous audience-only fact."] }),
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "fact_not_in_view");
  await assertNoPresentationArtifact(context.space);
});

test("guard: uncertainty_not_in_view — an audience uncertainty item absent from the view's projected uncertainty", async () => {
  const context = await makeContext();
  const pack = makePack({
    audience: makeAudience({
      adapt: ({ projection }) => ({
        ...cleanDraftFrom(projection),
        uncertainty: [...projection.uncertainty, "An extraneous audience-only uncertainty item."],
      }),
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "uncertainty_not_in_view");
  await assertNoPresentationArtifact(context.space);
});

test("guard: required_fact_hidden — an audience adaptation that drops a required baseline fact", async () => {
  // This guard and uncertainty_hidden below were both deleted at one point
  // with the whole suite staying green, because the fixture's own audiences
  // never happen to drop a required fact or uncertainty item.
  const context = await makeContext();
  const view = makeView({
    project: () => ({ ...cleanProjection(), facts: ["Fact A.", "Fact B."], requiredFacts: ["Fact A."] }),
  });
  const pack = makePack({
    view,
    audience: makeAudience({
      // A clean subset of view.facts (so fact_not_in_view does not also
      // fire) that simply omits the one required fact.
      adapt: ({ projection }) => ({ ...cleanDraftFrom(projection), facts: projection.facts.filter((fact) => fact !== "Fact A.") }),
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "required_fact_hidden");
  await assertNoPresentationArtifact(context.space);
});

test("guard: uncertainty_hidden — an audience adaptation that drops explicit uncertainty", async () => {
  // The other half of the guard pair; see the comment on
  // required_fact_hidden above.
  const context = await makeContext();
  const pack = makePack({
    audience: makeAudience({
      // The empty list is trivially a subset of view.uncertainty (so
      // uncertainty_not_in_view does not also fire) while omitting every
      // uncertainty item the view declared.
      adapt: ({ projection }) => ({ ...cleanDraftFrom(projection), uncertainty: [] }),
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "uncertainty_hidden");
  await assertNoPresentationArtifact(context.space);
});

test("guard: action_unauthorized — a duplicate-action projection lets an audience smuggle an invented action past the unchanged-action-set check", async () => {
  // guardedRetrieval.test.ts already pins action_unauthorized for the case where
  // the action SET genuinely changes (actionChanged === true). This
  // complements it with a case that check does not cover: `sameSet` compares
  // via `Set`, so a duplicated projection action ("Do the baseline thing."
  // twice) lets a draft swap one copy for an invented action while `sameSet`
  // still reports true (same length, and every projection element is still
  // present in the draft's set). actionChanged is therefore false,
  // recommendation_required/recommendation_distinct_required are correctly
  // skipped, and action_unauthorized — which runs unconditionally — is the
  // only guard left standing to catch the invented action text.
  const context = await makeContext();
  const view = makeView({ project: () => ({ ...cleanProjection(), actions: ["Do the baseline thing.", "Do the baseline thing."] }) });
  const pack = makePack({
    view,
    audience: makeAudience({
      adapt: ({ projection }) => ({
        ...cleanDraftFrom(projection),
        actions: ["Do the baseline thing.", "FICTIONAL-INVENTED-ACTION not authorized by anything."],
      }),
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "action_unauthorized", "audience.actions");
  await assertNoPresentationArtifact(context.space);
});

test("guard: recommendation_required — an action-changing adaptation that cites no recommendation at all", async () => {
  // Citing zero recommendations makes BOTH `recommendation_required`
  // (draft.recommendationIds.length === 0) and `recommendation_distinct_required`
  // (vacuously: no cited id is "distinct" when there are no cited ids) fire
  // together — the two checks are structurally inseparable in this exact
  // scenario. The assertion below targets recommendation_required by
  // identity and intentionally does not assert the co-occurring distinct
  // code, so the distinct guard remains pinned by its own isolated test.
  const context = await makeContext();
  const view = makeView({ project: () => ({ ...cleanProjection(), actions: ["Original synthetic action."] }) });
  const pack = makePack({
    view,
    audience: makeAudience({
      // Dropping every action (not inventing one) keeps action_unauthorized
      // out of this test: its loop has nothing to iterate over.
      adapt: ({ projection }) => ({ ...cleanDraftFrom(projection), actions: [] }),
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assert.ok(
    result.errors.some((error) => error.code === "recommendation_required"),
    `expected recommendation_required, got ${JSON.stringify(result.errors)}`,
  );
  await assertNoPresentationArtifact(context.space);
});

test("guard: recommendation_distinct_required — an action-changing adaptation that cites only the recommendation the baseline already used", async () => {
  const context = await makeContext();
  const view = makeView({
    project: () => ({ ...cleanProjection(), actions: ["Original synthetic action."], recommendationIds: ["recommendation"] }),
  });
  const pack = makePack({
    view,
    audience: makeAudience({
      // Actions dropped (not invented) so action_unauthorized cannot fire;
      // recommendationIds is non-empty, so recommendation_required
      // (length === 0) cannot fire either — only "cited nothing new" can.
      adapt: ({ projection }) => ({ ...cleanDraftFrom(projection), actions: [], recommendationIds: ["recommendation"] }),
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["recommendation"]) }),
  );
  assertOnlyError(result, "recommendation_distinct_required");
  await assertNoPresentationArtifact(context.space);
});

test("guard: recommendation_invalid — an adaptation draft recommendationId absent from the retrieved records", async () => {
  const context = await makeContext();
  // actions are left unchanged from the projection, so actionChanged is
  // false and validateRecommendationIds is reached on the adaptation path
  // without any action-related guard also firing.
  const pack = makePack({
    audience: makeAudience({
      adapt: ({ projection }) => ({ ...cleanDraftFrom(projection), recommendationIds: ["totally-fictional-id-xyz"] }),
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "recommendation_invalid", "recommendationIds");
  await assertNoPresentationArtifact(context.space);
});

test("guard: view_projection_invalid — malformed projection scalars return structured errors instead of rejecting", async () => {
  const context = await makeContext();
  const projection = cleanProjection();
  const pack = makePack({
    view: makeView({
      project: () => withRuntimeValue(projection, { ...projection, title: 42 }),
    }),
  });
  const result = await renderPresentation(
    baseRequest(pack),
    { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) },
  );

  const failure = failed(result);
  assert.equal(failure.errors[0]?.code, "view_projection_invalid");
  assert.equal(failure.errors[0]?.field, "view.title");
});

test("guard: audience_adaptation_invalid — malformed draft scalars return structured errors instead of rejecting", async () => {
  const context = await makeContext();
  const pack = makePack({
    audience: makeAudience({
      adapt: ({ projection }) => {
        const draft = cleanDraftFrom(projection);
        return withRuntimeValue(draft, { ...draft, title: 42 });
      },
    }),
  });
  const result = await renderPresentation(
    baseRequest(pack),
    { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) },
  );

  const failure = failed(result);
  assert.equal(failure.errors[0]?.code, "audience_adaptation_invalid");
  assert.equal(failure.errors[0]?.field, "audience.title");
});

test("property: presentation receipt metadata is snapshotted before callbacks can mutate definitions", async () => {
  const context = await makeContext();
  const projection = cleanProjection();
  const view: ViewDefinition = {
    id: "metadata-view",
    version: 1,
    scope: "search",
    retrievalQuery: () => {
      view.version = -10;
      return "beacon";
    },
    project: () => {
      view.version = -20;
      return projection;
    },
  };
  const audience: AudienceDefinition = {
    id: "metadata-audience",
    version: 1,
    authorize: () => true,
    adapt: ({ projection: projected }) => {
      audience.version = -30;
      return cleanDraftFrom(projected);
    },
  };
  const pack = makePack({ view, audience });
  const result = await renderPresentation(
    baseRequest(pack),
    { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) },
  );

  assert.equal(result.status, "presented");
  if (result.status !== "presented") return;
  assert.equal(result.receipt.viewVersion, 1);
  assert.equal(result.receipt.audienceVersion, 1);
  assert.equal(result.receipt.pack.version, "0.1.0");
});

test("guard: text_empty — an empty audience.summary returned by adapt", async () => {
  const context = await makeContext();
  const pack = makePack({
    audience: makeAudience({
      adapt: ({ projection }) => ({ ...cleanDraftFrom(projection), summary: "   " }),
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "text_empty", "audience.summary");
  await assertNoPresentationArtifact(context.space);
});

test("guard: text_multiline — a multi-line audience.title returned by adapt", async () => {
  const context = await makeContext();
  const pack = makePack({
    audience: makeAudience({
      adapt: ({ projection }) => ({ ...cleanDraftFrom(projection), title: "Audience title\nsecond line" }),
    }),
  });
  const result = failed(
    await renderPresentation(baseRequest(pack), { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) }),
  );
  assertOnlyError(result, "text_multiline", "audience.title");
  await assertNoPresentationArtifact(context.space);
});

// The returned-draft half of review item 2. `snapshotDelivery` covers what the
// harness hands a callback; this covers what the callback hands back. The
// brief names the exact adversary: an accessor-backed field passes
// `validateAdaptation` and then answers differently when `renderContent`
// reads it, so the audience sees prose no guard ever inspected. Freezing is
// not enough — a frozen object with a getter still answers per read.
test("property: a draft whose fields answer differently on each read is rendered from the validated snapshot, not the callback's live object", async () => {
  const context = await makeContext();
  let titleReads = 0;
  const pack = makePack({
    audience: makeAudience({
      adapt: ({ projection }) => {
        const base = cleanDraftFrom(projection);
        return {
          ...base,
          get title(): string {
            titleReads += 1;
            return titleReads === 1 ? "Valid synthetic audience title" : "SMUGGLED-UNVALIDATED-TITLE";
          },
        };
      },
    }),
  });
  const result = await renderPresentation(
    baseRequest(pack),
    { env: context.env, spawnFn: scriptedSpawn(context.collection, ["status-brief"]) },
  );

  assert.equal(result.status, "presented");
  if (result.status !== "presented") return;
  // The validated value is the only value that may reach the audience.
  assert.match(result.content, /Valid synthetic audience title/);
  assert.doesNotMatch(result.content, /SMUGGLED-UNVALIDATED-TITLE/);
  // The snapshot must take each field exactly once, so a second read of the
  // live getter can never occur downstream of validation.
  assert.equal(titleReads, 1);
});
