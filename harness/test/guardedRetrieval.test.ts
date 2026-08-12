import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import {
  guardedRetrieve,
} from "../src/guardedRetrieval.ts";
import * as guardedRetrievalSurface from "../src/guardedRetrieval.ts";
import {
  renderPresentation,
  type PresentationPack,
  type PresentationSuccess,
} from "../src/presentation.ts";
import { fictionalPack } from "../test/fictionalPack.ts";
import { deepFreeze } from "../src/deepFreeze.ts";
import { parseKnowledgeRecord } from "../src/knowledgeRecord.ts";
import type { KnowledgeRecord } from "../src/knowledgeTypes.ts";
import type { SpawnFn } from "../src/qmdRunner.ts";
import { registerSpace, selectSpace } from "../src/spaceRegistry.ts";
import { makeScriptedSpawnFn } from "./fakes.ts";
import {
  createEphemeralSpace,
  destroyEphemeralSpace,
  FIXTURES_DIR,
  writeLocalBindingFixture,
  type EphemeralSpace,
} from "./testSupport.ts";

const execFileAsync = promisify(execFile);
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const RETRIEVAL_RECORDS_DIR = join(FIXTURES_DIR, "retrieval-space", "records");
const RETRIEVAL_SPACE_B_RECORDS_DIR = join(FIXTURES_DIR, "retrieval-space-b", "records");
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
  const space = await createEphemeralSpace(RETRIEVAL_RECORDS_DIR, `retrieval-space-${number}`);
  spacesToClean.push(space);
  const registryPath = join(space.root, "registry.json");
  const bindingPath = await writeLocalBindingFixture(space, "fictional-space-retrieval");
  const registered = await registerSpace(registryPath, bindingPath);
  assert.equal(registered.ok, true);
  const selected = await selectSpace(registryPath, "fictional-space-retrieval", `retrieval-session-${number}`);
  assert.equal(selected.ok, true);
  return {
    space,
    collection: space.binding.qmdCollectionName,
    env: {
      ENGRAM_BINDING_REGISTRY: registryPath,
      ENGRAM_HOST_SESSION_ID: `retrieval-session-${number}`,
    },
  };
}

function hit(collection: string, id: string, score = 0.95): { file: string; score: number } {
  return { file: `qmd://${collection}/${id}.md`, score };
}

function qmdOutput(collection: string, ids: string[], score = 0.95): string {
  return JSON.stringify(ids.map((id) => hit(collection, id, score)));
}

function dynamicCollectionSpawn(ids: string[]): SpawnFn {
  return (command, args, options) => {
    const collection = args[args.length - 1];
    if (collection === undefined) throw new Error("synthetic qmd invocation omitted its collection");
    return makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(collection, ids) }]).spawnFn(command, args, options);
  };
}

function attemptRecordMutation(record: KnowledgeRecord, observations: string[]): void {
  try {
    record.statement = "FICTIONAL-MUTATED-STATEMENT";
  } catch {
    // A frozen render snapshot is expected to reject the attempted mutation.
  }
  try {
    record.details.basis = "FICTIONAL-MUTATED-DETAIL";
  } catch {
    // A frozen nested detail is expected to reject the attempted mutation.
  }
  const source = record.sources[0];
  if (source !== undefined) {
    try {
      source.ref = "FICTIONAL-MUTATED-SOURCE";
    } catch {
      // A frozen nested source is expected to reject the attempted mutation.
    }
  }
  observations.push(JSON.stringify({ statement: record.statement, details: record.details, sources: record.sources }));
}

function success(result: Awaited<ReturnType<typeof renderPresentation>>): PresentationSuccess {
  assert.equal(result.status, "presented");
  if (result.status !== "presented") throw new Error("expected a successful presentation");
  return result;
}

function spaceScopedPack(): PresentationPack {
  const view = fictionalPack.views[0];
  const delivery = fictionalPack.deliveries.find((candidate) => candidate.retain === false);
  if (view === undefined || delivery === undefined) throw new Error("fictional presentation pack is incomplete");
  return {
    ...fictionalPack,
    views: [{ ...view, scope: "space" }],
    deliveries: [{ ...delivery, id: "space-check", maxWords: 1_000 }],
  };
}

function spaceRequest(pack: PresentationPack, query?: string): Parameters<typeof renderPresentation>[0] {
  return {
    viewId: "project-status",
    audienceId: "peer",
    deliveryId: "space-check",
    ...(query === undefined ? {} : { query }),
    model: "fictional-provider/fictional-model",
    generatedAt: "2026-08-05T12:00:00.000Z",
    pack,
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !pathFromRoot.startsWith(sep));
}

test("property: model-facing guarded retrieval exports only caller-safe operations", () => {
  assert.deepEqual(Object.keys(guardedRetrievalSurface).sort(), [
    "guardedRetrieve",
    "isGuardedRetrievalFailure",
    "isGuardedRetrievalHit",
    "isGuardedRetrievalMiss",
  ]);
});

test("property: model retrieval stays active-space-only when a qmd locator names a sibling or escapes the records root", async () => {
  const context = await makeContext();
  const foreign = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: JSON.stringify([{ file: "qmd://fictional-sibling/restricted-note.md", score: 0.99 }]) }]);
  const foreignResult = await guardedRetrieve(
    { query: "synthetic status", audienceId: "peer" , pack: fictionalPack },
    { env: context.env, spawnFn: foreign.spawnFn },
  );
  assert.equal(foreignResult.status, "failed");
  assert.equal(foreign.calls[0]?.args.at(-1), context.collection);
  assert.doesNotMatch(JSON.stringify(foreignResult), /FICTIONAL-UNAUTHORIZED/);

  const escaping = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: JSON.stringify([{ file: `qmd://${context.collection}/../restricted-note.md`, score: 0.99 }]) }]);
  const escapingResult = await guardedRetrieve(
    { query: "synthetic status", audienceId: "peer", pack: fictionalPack },
    { env: context.env, spawnFn: escaping.spawnFn },
  );
  assert.equal(escapingResult.status, "failed");
  assert.doesNotMatch(JSON.stringify(escapingResult), /FICTIONAL-UNAUTHORIZED/);
});

test("property: retrieval receipts name the active space and policy inputs while exact misses remain explicit and qmd failures remain failures", async () => {
  const context = await makeContext();
  const missSpawn = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "No results found.\n" }]);
  const miss = await guardedRetrieve(
    { query: "no synthetic result", audienceId: "peer", pack: fictionalPack },
    { env: context.env, spawnFn: missSpawn.spawnFn },
  );
  assert.equal(miss.status, "miss");
  if (miss.status !== "miss") return;
  assert.equal(miss.receipt.activeSpace, "fictional-space-retrieval");
  assert.deepEqual(miss.receipt.requestedSourceClasses, ["status", "risk", "recommendation", "restricted"]);
  assert.deepEqual(miss.receipt.allowedSourceClasses, ["status", "risk", "recommendation", "restricted"]);
  assert.deepEqual(miss.receipt.exposedResults, []);

  const failedSpawn = makeScriptedSpawnFn([{ ranProcess: true, code: 7, stderr: "synthetic qmd failure" }]);
  const failed = await guardedRetrieve(
    { query: "synthetic failure", audienceId: "peer", pack: fictionalPack },
    { env: context.env, spawnFn: failedSpawn.spawnFn },
  );
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(JSON.stringify(failed), /evidence of absence/);
});

test("property: one render remains bound to its first resolved space when active selection changes before guarded retrieval", async () => {
  const spaceA = await createEphemeralSpace(RETRIEVAL_RECORDS_DIR, "retrieval-switch-collection-a");
  const spaceB = await createEphemeralSpace(RETRIEVAL_SPACE_B_RECORDS_DIR, "retrieval-switch-collection-b");
  spacesToClean.push(spaceA, spaceB);
  const registryPath = join(spaceA.root, "registry.json");
  const bindingA = await writeLocalBindingFixture(spaceA, "fictional-space-retrieval");
  const bindingB = await writeLocalBindingFixture(spaceB, "fictional-space-retrieval-b");
  assert.equal((await registerSpace(registryPath, bindingA)).ok, true);
  assert.equal((await registerSpace(registryPath, bindingB)).ok, true);
  assert.equal((await selectSpace(registryPath, "fictional-space-retrieval", "retrieval-switch-session-a")).ok, true);
  assert.equal((await selectSpace(registryPath, "fictional-space-retrieval-b", "retrieval-switch-session-b")).ok, true);

  let selectionReads = 0;
  const switchingEnv = {
    ENGRAM_BINDING_REGISTRY: registryPath,
    get ENGRAM_HOST_SESSION_ID(): string {
      selectionReads++;
      return selectionReads === 1 ? "retrieval-switch-session-a" : "retrieval-switch-session-b";
    },
  };
  const result = success(await renderPresentation(
    {
      viewId: "project-status",
      audienceId: "supervisor",
      deliveryId: "weekly-markdown",
      model: "fictional-provider/fictional-model",
      generatedAt: "2026-08-05T12:00:00.000Z",
      pack: fictionalPack,
    },
    { env: switchingEnv, spawnFn: dynamicCollectionSpawn(["status-brief"]) },
  ));

  assert.equal(selectionReads, 1);
  assert.equal(result.receipt.activeSpace, "fictional-space-retrieval");
  assert.equal(result.receipt.retrievalReceipt.activeSpace, "fictional-space-retrieval");
  assert.equal(result.receipt.retrievalReceipt.collection, spaceA.binding.qmdCollectionName);
  assert.ok(result.receipt.sourceReferences.every((reference) => reference.sourceUri.startsWith(`qmd://${spaceA.binding.qmdCollectionName}/`)));
  assert.ok(result.retained?.artifactPath.startsWith(join(await realpath(spaceA.root), ".engram-presentations")));
  assert.equal(result.content.includes("The beacon project remains on track for the synthetic review."), true);
  assert.equal(result.content.includes("The alternate synthetic space must not enter this render."), false);
});

test("property: a space-scoped view returns every authorized active record with no query supplied", async () => {
  const context = await makeContext();
  const result = success(await renderPresentation(spaceRequest(spaceScopedPack()), {
    env: context.env,
    spawnFn: () => {
      throw new Error("space enumeration must not invoke qmd");
    },
  }));
  assert.equal(result.receipt.retrievalReceipt.scope, "space");
  assert.deepEqual(result.receipt.sourceRecordIds, ["recommendation", "recommendation-alt", "risk-note", "status-brief"]);
});

test("property: an enumerated receipt reports no relevance threshold, even though the pack declares one", async () => {
  const context = await makeContext();
  const result = success(await renderPresentation(spaceRequest(spaceScopedPack()), { env: context.env }));
  assert.equal(result.receipt.retrievalReceipt.scope, "space");
  assert.equal(result.receipt.retrievalReceipt.relevanceThreshold, null);
});

test("property: an enumerated receipt does not fabricate a query", async () => {
  const context = await makeContext();
  const result = success(await renderPresentation(spaceRequest(spaceScopedPack()), { env: context.env }));
  assert.equal(result.receipt.retrievalReceipt.scope, "space");
  assert.equal(result.receipt.retrievalReceipt.query, null);
});

test("property: a space-scoped view refuses a caller-supplied query with query_not_scoped", async () => {
  const context = await makeContext();
  const result = await renderPresentation(spaceRequest(spaceScopedPack(), "beacon"), { env: context.env });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["query_not_scoped"]);
});

test("property: an unknown runtime view scope is refused before retrieval instead of silently selecting search", async () => {
  const context = await makeContext();
  const invalidPack = spaceScopedPack();
  const view = invalidPack.views[0];
  if (view === undefined) throw new Error("space-scoped pack has no view");
  Object.defineProperty(view, "scope", { value: "invalid" });
  const result = await renderPresentation(spaceRequest(invalidPack), { env: context.env });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.deepEqual(result.errors.map((error) => error.code), ["view_scope_invalid"]);
});

test("property: enumeration does not read a record whose real path escapes the records root", async () => {
  const context = await makeContext();
  const outside = join(context.space.root, "outside.md");
  const escaping = join(context.space.binding.recordsRoot, "escaping.md");
  await writeFile(outside, "outside\n", "utf8");
  await symlink(outside, escaping);
  const result = await renderPresentation(spaceRequest(spaceScopedPack()), { env: context.env });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.errors[0]?.code, "path_escape");
});

test("property: enumeration excludes presentation artifacts, so a retained rendering cannot become evidence for the next rendering", async () => {
  const context = await makeContext();
  const pack = spaceScopedPack();
  pack.retrievalPolicy = {
    ...pack.retrievalPolicy,
    allowedSourceClasses: [...pack.retrievalPolicy.allowedSourceClasses, "presentation"],
  };
  const result = success(await renderPresentation(spaceRequest(pack), { env: context.env }));
  assert.equal(result.receipt.sourceRecordIds.includes("presentation-source"), false);
});

test("property: pack retrieval policy shapes the query and filters source class, relevance, eligibility, and presentations", async () => {
  const context = await makeContext();
  const sourceFilteredSpawn = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note"]) }]);
  const sourceFiltered = await guardedRetrieve(
    { query: "synthetic status", audienceId: "peer", requestedSourceClasses: ["risk"], pack: fictionalPack },
    { env: context.env, spawnFn: sourceFilteredSpawn.spawnFn },
  );
  assert.equal(sourceFiltered.status, "hit");
  if (sourceFiltered.status !== "hit") return;
  assert.deepEqual(sourceFiltered.records.map((record) => record.record.id), ["risk-note"]);
  assert.deepEqual(sourceFiltered.receipt.recordIds, ["risk-note"]);
  assert.deepEqual(sourceFiltered.receipt.exposedResults.map((record) => record.recordId), ["risk-note"]);
  assert.equal(sourceFilteredSpawn.calls[0]?.args[1], "synthetic status [view:none] [sources:risk]");

  const lowRelevanceSpawn = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"], 0.1) }]);
  const lowRelevance = await guardedRetrieve(
    { query: "synthetic status", audienceId: "peer", requestedSourceClasses: ["status"], pack: fictionalPack },
    { env: context.env, spawnFn: lowRelevanceSpawn.spawnFn },
  );
  assert.equal(lowRelevance.status, "miss");
  assert.equal(lowRelevanceSpawn.calls[0]?.args[1], "synthetic status [view:none] [sources:status]");

  const inactiveSpawn = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["inactive-note", "risk-note"]) }]);
  const inactive = await guardedRetrieve(
    { query: "synthetic status", audienceId: "peer", requestedSourceClasses: ["risk"], pack: fictionalPack },
    { env: context.env, spawnFn: inactiveSpawn.spawnFn },
  );
  assert.equal(inactive.status, "hit");
  if (inactive.status !== "hit") return;
  assert.deepEqual(inactive.records.map((record) => record.record.id), ["risk-note"]);
  assert.deepEqual(inactive.receipt.recordIds, ["risk-note"]);

  const presentationSpawn = makeScriptedSpawnFn([{
    ranProcess: true,
    code: 0,
    stdout: JSON.stringify([{ file: `qmd://${context.collection}/.engram-presentations/synthetic/presentation.md`, score: 0.99 }]),
  }]);
  const retainedPresentationPath = join(context.space.root, ".engram-presentations", "synthetic", "presentation.md");
  await mkdir(join(context.space.root, ".engram-presentations", "synthetic"), { recursive: true });
  await writeFile(retainedPresentationPath, "# Synthetic retained presentation\n", "utf8");
  const presentation = await guardedRetrieve(
    { query: "synthetic presentation", audienceId: "peer", requestedSourceClasses: ["status"], pack: fictionalPack },
    { env: context.env, spawnFn: presentationSpawn.spawnFn },
  );
  assert.equal(presentation.status, "miss");
  if (presentation.status !== "miss") return;
  assert.deepEqual(presentation.receipt.recordIds, []);
  assert.deepEqual(presentation.receipt.exposedResults, []);

  const presentationSourcePack: PresentationPack = {
    ...fictionalPack,
    retrievalPolicy: {
      ...fictionalPack.retrievalPolicy,
      allowedSourceClasses: [...fictionalPack.retrievalPolicy.allowedSourceClasses, "presentation"],
    },
  };
  const presentationSourceSpawn = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["presentation-source"]) }]);
  const presentationSource = await guardedRetrieve(
    { query: "synthetic presentation source", audienceId: "peer", requestedSourceClasses: ["presentation"], pack: presentationSourcePack },
    { env: context.env, spawnFn: presentationSourceSpawn.spawnFn },
  );
  assert.equal(presentationSource.status, "miss");
  if (presentationSource.status !== "miss") return;
  assert.deepEqual(presentationSource.receipt.recordIds, []);

  const disallowed = await guardedRetrieve(
    { query: "synthetic status", audienceId: "peer", requestedSourceClasses: ["not-configured"], pack: fictionalPack },
    { env: context.env, spawnFn: sourceFilteredSpawn.spawnFn },
  );
  assert.equal(disallowed.status, "failed");
  assert.equal(sourceFilteredSpawn.calls.length, 1, "a disallowed class is refused before a second qmd call");
});

test("property: an unauthorized record is filtered from a render, not a whole-request denial, and the receipt records how many were withheld and for which audience", async () => {
  const context = await makeContext();
  const fourRecords = qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation", "restricted-note"]);

  const peerScripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: fourRecords }]);
  const peer = await renderPresentation(
    { viewId: "project-status", audienceId: "peer", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-06T00:00:00.000Z", pack: fictionalPack },
    { env: context.env, spawnFn: peerScripted.spawnFn },
  );
  assert.equal(peer.status, "presented");
  if (peer.status !== "presented") return;
  assert.doesNotMatch(peer.content, /FICTIONAL-UNAUTHORIZED-STATEMENT|FICTIONAL-UNAUTHORIZED-DETAIL|FICTIONAL-UNAUTHORIZED-SOURCE/);
  assert.doesNotMatch(JSON.stringify(peer.receipt), /FICTIONAL-UNAUTHORIZED-STATEMENT|FICTIONAL-UNAUTHORIZED-DETAIL|FICTIONAL-UNAUTHORIZED-SOURCE/);
  assert.deepEqual(peer.receipt.sourceRecordIds, ["recommendation", "risk-note", "status-brief"]);
  assert.equal(peer.receipt.sourceRecordIds.includes("restricted-note"), false);
  assert.deepEqual(peer.receipt.retrievalReceipt.withheld, { audienceId: "peer", count: 1 });

  const supervisorScripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: fourRecords }]);
  const supervisor = await renderPresentation(
    { viewId: "project-status", audienceId: "supervisor", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-06T00:00:00.000Z", pack: fictionalPack },
    { env: context.env, spawnFn: supervisorScripted.spawnFn },
  );
  assert.equal(supervisor.status, "presented");
  if (supervisor.status !== "presented") return;
  assert.deepEqual(supervisor.receipt.sourceRecordIds, ["recommendation", "restricted-note", "risk-note", "status-brief"]);
  assert.deepEqual(supervisor.receipt.retrievalReceipt.withheld, { audienceId: "supervisor", count: 0 });
});

test("property: a guarded retrieval whose only qmd match is authorization-restricted is an explicit miss whose STATUS matches a query that matched nothing, while the receipt still discloses the withheld count", async () => {
  const context = await makeContext();
  const restrictedOnly = await guardedRetrieve(
    { query: "synthetic status", audienceId: "peer", pack: fictionalPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["restricted-note"]) }]).spawnFn },
  );
  assert.equal(restrictedOnly.status, "miss");
  if (restrictedOnly.status !== "miss") return;
  assert.doesNotMatch(JSON.stringify(restrictedOnly), /FICTIONAL-UNAUTHORIZED-STATEMENT|FICTIONAL-UNAUTHORIZED-DETAIL|FICTIONAL-UNAUTHORIZED-SOURCE/);
  assert.deepEqual(restrictedOnly.receipt.withheld, { audienceId: "peer", count: 1 });

  const noMatch = await guardedRetrieve(
    { query: "synthetic status", audienceId: "peer", pack: fictionalPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "No results found.\n" }]).spawnFn },
  );
  assert.equal(noMatch.status, "miss");

  // The property under test: a caller who can never read restricted content
  // must not be able to learn, from outcome status alone, whether restricted
  // content matched their query. Both probes are `miss`.
  assert.equal(restrictedOnly.status, noMatch.status);

  // What is NOT yet established, pinned here deliberately so it cannot be
  // closed by accident. `cli.ts` prints the whole result — receipt included —
  // to the caller, so the withheld count is currently visible on the same
  // channel as the status, and the two responses ARE distinguishable at the
  // payload level. This disclosure is intentional, not an oversight. If this
  // assertion ever starts failing, someone has closed the disclosure — which
  // is the right outcome, but it must be recorded visibly in the affected
  // current document rather than silently deleting this assertion.
  assert.notDeepEqual(restrictedOnly.receipt.withheld, noMatch.receipt.withheld);
});

test("property: one audience-independent project-status view preserves baseline facts and uncertainty for two configured audiences and delivery constraints", async () => {
  const context = await makeContext();
  const output = qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation"]);
  const supervisor = success(await renderPresentation(
    { viewId: "project-status", audienceId: "supervisor", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:00.000Z", pack: fictionalPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: output }]).spawnFn },
  ));
  const peer = success(await renderPresentation(
    { viewId: "project-status", audienceId: "peer", deliveryId: "chat-brief", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:01.000Z", pack: fictionalPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: output }]).spawnFn },
  ));
  for (const presentation of [supervisor, peer]) {
    assert.match(presentation.content, /The beacon project remains on track/);
    assert.match(presentation.content, /Timing estimate is provisional/);
    assert.deepEqual(presentation.receipt.sourceRecordIds, ["recommendation", "risk-note", "status-brief"]);
  }
  assert.match(supervisor.content, /The export rehearsal has a timing risk/);
  assert.doesNotMatch(peer.content, /The export rehearsal has a timing risk/);
  assert.notEqual(supervisor.content, peer.content);
  assert.equal(supervisor.receipt.viewId, peer.receipt.viewId);
  assert.notEqual(supervisor.receipt.deliveryId, peer.receipt.deliveryId);
});

test("property: adding a third fictional audience is configuration-only and does not require a core audience branch", async () => {
  const context = await makeContext();
  const thirdAudiencePack: PresentationPack = {
    ...fictionalPack,
    audiences: [
      ...fictionalPack.audiences,
      {
        id: "reviewer",
        version: 1,
        authorize: () => true,
        adapt: ({ projection }) => ({
          title: "Reviewer lens",
          summary: projection.summary,
          facts: projection.requiredFacts,
          uncertainty: projection.uncertainty,
          actions: projection.actions,
          recommendationIds: [],
        }),
      },
    ],
  };
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation"]) }]);
  const result = await renderPresentation(
    { viewId: "project-status", audienceId: "reviewer", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:00.000Z", pack: thirdAudiencePack },
    { env: context.env, spawnFn: scripted.spawnFn },
  );
  assert.equal(result.status, "presented");
});

test("property: retrieval and rendering leave authoritative Markdown bytes and parsed active records unchanged", async () => {
  const context = await makeContext();
  const before = new Map<string, Buffer>();
  const beforeRecords = new Map<string, KnowledgeRecord>();
  for (const name of await readdir(context.space.binding.recordsRoot)) {
    before.set(name, await readFile(join(context.space.binding.recordsRoot, name)));
    const parsed = parseKnowledgeRecord(await readFile(join(context.space.binding.recordsRoot, name), "utf8"));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    beforeRecords.set(name, parsed.value);
  }
  const output = qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation"]);
  success(await renderPresentation(
    { viewId: "project-status", audienceId: "supervisor", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:00.000Z", pack: fictionalPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: output }]).spawnFn },
  ));
  success(await renderPresentation(
    { viewId: "project-status", audienceId: "peer", deliveryId: "chat-brief", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:01.000Z", pack: fictionalPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: output }]).spawnFn },
  ));
  const observations: string[] = [];
  const baseView = fictionalPack.views.find((candidate) => candidate.id === "project-status");
  if (baseView === undefined) throw new Error("synthetic project-status view is missing");
  const mutatingPack: PresentationPack = {
    ...fictionalPack,
    views: [{
      ...baseView,
      project: (records) => {
        const first = records[0];
        if (first !== undefined) attemptRecordMutation(first, observations);
        return baseView.project(records);
      },
    }],
    audiences: [{
      id: "mutation-probe",
      version: 1,
      authorize: (record) => {
        attemptRecordMutation(record, observations);
        return true;
      },
      adapt: ({ projection, records }) => {
        const first = records[0];
        if (first !== undefined) attemptRecordMutation(first, observations);
        return {
          title: "Mutation probe",
          summary: projection.summary,
          facts: [...projection.facts],
          uncertainty: [...projection.uncertainty],
          actions: [...projection.actions],
          recommendationIds: [],
        };
      },
    }],
  };
  const mutationResult = success(await renderPresentation(
    { viewId: "project-status", audienceId: "mutation-probe", deliveryId: "chat-brief", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:02.000Z", pack: mutatingPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]).spawnFn },
  ));
  assert.doesNotMatch(mutationResult.content, /FICTIONAL-MUTATED-STATEMENT|FICTIONAL-MUTATED-DETAIL|FICTIONAL-MUTATED-SOURCE/);
  assert.equal(observations.length, 3);
  for (const observation of observations) {
    assert.doesNotMatch(observation, /FICTIONAL-MUTATED-STATEMENT|FICTIONAL-MUTATED-DETAIL|FICTIONAL-MUTATED-SOURCE/);
  }
  for (const [name, bytes] of before) assert.deepEqual(await readFile(join(context.space.binding.recordsRoot, name)), bytes);
  for (const [name, beforeRecord] of beforeRecords) {
    const parsed = parseKnowledgeRecord(await readFile(join(context.space.binding.recordsRoot, name), "utf8"));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    assert.deepEqual(parsed.value, beforeRecord);
  }
});

test("property: an unchanged baseline action is always cited by the successful presentation receipt", async () => {
  const context = await makeContext();
  const result = success(await renderPresentation(
    { viewId: "project-status", audienceId: "supervisor", deliveryId: "chat-brief", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:00.000Z", pack: fictionalPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation"]) }]).spawnFn },
  ));
  assert.deepEqual(result.receipt.recommendationIds, ["recommendation"]);
});

test("property: action-changing adaptation fails without a distinct authorized recommendation and succeeds with one listed in the receipt", async () => {
  const context = await makeContext();
  const unauthorizedActionPack: PresentationPack = {
    ...fictionalPack,
    audiences: [
      ...fictionalPack.audiences,
      {
        id: "actionless-reviewer",
        version: 1,
        authorize: () => true,
        adapt: ({ projection }) => ({
          title: projection.title,
          summary: projection.summary,
          facts: projection.requiredFacts,
          uncertainty: projection.uncertainty,
          actions: ["Take an unrecorded synthetic action."],
          recommendationIds: [],
        }),
      },
    ],
  };
  const invalid = await renderPresentation(
    { viewId: "project-status", audienceId: "actionless-reviewer", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:00.000Z", pack: unauthorizedActionPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation"]) }]).spawnFn },
  );
  assert.equal(invalid.status, "failed");

  const reusedBaselinePack: PresentationPack = {
    ...fictionalPack,
    audiences: [
      ...fictionalPack.audiences,
      {
        id: "baseline-reuse-reviewer",
        version: 1,
        authorize: () => true,
        adapt: ({ projection }) => ({
          title: projection.title,
          summary: projection.summary,
          facts: projection.requiredFacts,
          uncertainty: projection.uncertainty,
          actions: ["Take the recorded synthetic recommendation."],
          recommendationIds: ["recommendation"],
        }),
      },
    ],
  };
  const reusedBaseline = await renderPresentation(
    { viewId: "project-status", audienceId: "baseline-reuse-reviewer", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:00.500Z", pack: reusedBaselinePack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation"]) }]).spawnFn },
  );
  assert.equal(reusedBaseline.status, "failed");
  if (reusedBaseline.status === "failed") assert.ok(reusedBaseline.errors.some((error) => error.code === "recommendation_distinct_required"));

  const authorizedActionPack: PresentationPack = {
    ...fictionalPack,
    audiences: [
      ...fictionalPack.audiences,
      {
        id: "action-reviewer",
        version: 1,
        authorize: () => true,
        adapt: ({ projection }) => ({
          title: projection.title,
          summary: projection.summary,
          facts: projection.requiredFacts,
          uncertainty: projection.uncertainty,
          actions: ["Use a second synthetic rehearsal if the checkpoint slips."],
          recommendationIds: ["recommendation-alt"],
        }),
      },
    ],
  };
  const valid = await renderPresentation(
    { viewId: "project-status", audienceId: "action-reviewer", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:01.000Z", pack: authorizedActionPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation"]) }]).spawnFn },
  );
  assert.equal(valid.status, "failed");

  const validWithAlternate = await renderPresentation(
    { viewId: "project-status", audienceId: "action-reviewer", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:01.500Z", pack: authorizedActionPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation", "recommendation-alt"]) }]).spawnFn },
  );
  const presentation = success(validWithAlternate);
  assert.deepEqual(presentation.receipt.recommendationIds, ["recommendation", "recommendation-alt"]);
});

test("property: an adaptation whose action text is neither a view action nor the cited recommendation's statement is refused with action_unauthorized, and the exact statement is accepted", async () => {
  const context = await makeContext();
  const invalidActionPack: PresentationPack = {
    ...fictionalPack,
    audiences: [
      ...fictionalPack.audiences,
      {
        id: "unbound-action-reviewer",
        version: 1,
        authorize: () => true,
        adapt: ({ projection }) => ({
          title: projection.title,
          summary: projection.summary,
          facts: projection.requiredFacts,
          uncertainty: projection.uncertainty,
          // Cites recommendation-alt correctly, but the action prose is
          // invented rather than the record's own statement.
          actions: ["Take the alternate recorded synthetic recommendation."],
          recommendationIds: ["recommendation-alt"],
        }),
      },
    ],
  };
  const invalid = await renderPresentation(
    { viewId: "project-status", audienceId: "unbound-action-reviewer", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:02.000Z", pack: invalidActionPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation", "recommendation-alt"]) }]).spawnFn },
  );
  assert.equal(invalid.status, "failed");
  if (invalid.status === "failed") {
    assert.ok(
      invalid.errors.some((error) => error.code === "action_unauthorized"),
      `expected action_unauthorized, got ${JSON.stringify(invalid.errors)}`,
    );
  }

  const boundActionPack: PresentationPack = {
    ...fictionalPack,
    audiences: [
      ...fictionalPack.audiences,
      {
        id: "bound-action-reviewer",
        version: 1,
        authorize: () => true,
        adapt: ({ projection }) => ({
          title: projection.title,
          summary: projection.summary,
          facts: projection.requiredFacts,
          uncertainty: projection.uncertainty,
          // The cited record's exact statement, not a paraphrase.
          actions: ["Use a second synthetic rehearsal if the checkpoint slips."],
          recommendationIds: ["recommendation-alt"],
        }),
      },
    ],
  };
  const valid = await renderPresentation(
    { viewId: "project-status", audienceId: "bound-action-reviewer", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:02.500Z", pack: boundActionPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation", "recommendation-alt"]) }]).spawnFn },
  );
  const presentation = success(valid);
  assert.ok(presentation.content.includes("Use a second synthetic rehearsal if the checkpoint slips."));
});

test("property: presentation receipts reconstruct the successful presentation and retention is structurally outside routine records retrieval", async () => {
  const context = await makeContext();
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation"]) }]);
  const result = success(await renderPresentation(
    { viewId: "project-status", audienceId: "supervisor", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:00.000Z", pack: fictionalPack },
    { env: context.env, spawnFn: scripted.spawnFn },
  ));
  assert.equal(result.receipt.schemaVersion, 0);
  assert.match(result.receipt.presentationId, /^presentation-/);
  assert.equal(result.receipt.activeSpace, "fictional-space-retrieval");
  assert.equal(result.receipt.viewId, "project-status");
  assert.equal(result.receipt.audienceId, "supervisor");
  assert.equal(result.receipt.deliveryId, "weekly-markdown");
  assert.equal(result.receipt.model, "fictional-provider/fictional-model");
  assert.equal(result.receipt.retrievalReceipt.activeSpace, "fictional-space-retrieval");
  assert.equal(result.receipt.retrievalReceipt.kind, "hit");
  assert.deepEqual(result.receipt.retrievalReceipt.recordIds, ["status-brief", "risk-note", "recommendation"]);
  assert.match(result.receipt.generatedAt, /^2026-08-05T12:00:00\.000Z$/);
  assert.ok(result.retained?.artifactPath.includes(".engram-presentations"));
  assert.ok(result.retained?.artifactPath.includes("records") === false);

  const ordinary = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: JSON.stringify([{ file: `qmd://${context.collection}/.engram-presentations/${result.receipt.presentationId}/presentation.md`, score: 0.99 }]) }]);
  const retrieval = await guardedRetrieve(
    { query: "ordinary evidence", audienceId: "supervisor", pack: fictionalPack },
    { env: context.env, spawnFn: ordinary.spawnFn },
  );
  assert.equal(retrieval.status, "miss");
});

test("property: re-rendering an identical presentation is refused with presentation_already_retained instead of colliding on rename or silently overwriting", async () => {
  const context = await makeContext();
  const request = {
    viewId: "project-status",
    audienceId: "supervisor",
    deliveryId: "weekly-markdown",
    model: "fictional-provider/fictional-model",
    generatedAt: "2026-08-05T12:00:03.000Z",
    pack: fictionalPack,
  };
  const scriptedFirst = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation"]) }]);
  const first = success(await renderPresentation(request, { env: context.env, spawnFn: scriptedFirst.spawnFn }));
  if (first.retained === undefined) throw new Error("synthetic first render did not retain");
  const firstBytes = await readFile(first.retained.artifactPath, "utf8");

  const presentationsRoot = join(context.space.root, ".engram-presentations");
  assert.deepEqual(await readdir(presentationsRoot), [first.receipt.presentationId]);

  const scriptedSecond = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation"]) }]);
  const second = await renderPresentation(request, { env: context.env, spawnFn: scriptedSecond.spawnFn });
  assert.equal(second.status, "failed");
  if (second.status === "failed") {
    assert.ok(
      second.errors.some((error) => error.code === "presentation_already_retained"),
      `expected presentation_already_retained, got ${JSON.stringify(second.errors)}`,
    );
  }

  assert.deepEqual(
    await readdir(presentationsRoot),
    [first.receipt.presentationId],
    "the presentation root must contain exactly the one retained directory and no pending entry",
  );
  assert.equal(
    await readFile(first.retained.artifactPath, "utf8"),
    firstBytes,
    "the first render's retained artifact must be unchanged by the refused re-render",
  );
});

test("property: deepFreeze terminates and freezes a self-referential object graph instead of recursing forever", { timeout: 2000 }, () => {
  const cyclic: { label: string; self?: unknown } = { label: "synthetic-cycle" };
  cyclic.self = cyclic;
  const frozen = deepFreeze(cyclic);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(frozen.self, cyclic);
});

test("property: retained presentation writes stay beneath a separately authorized presentation root", async () => {
  const space = await createEphemeralSpace(RETRIEVAL_RECORDS_DIR, "retrieval-separated-retention");
  spacesToClean.push(space);
  const presentationRoot = join(space.root, ".engram-presentations");
  await mkdir(presentationRoot, { recursive: true });
  const authorizedPresentationRoot = await realpath(presentationRoot);
  const bindingPath = await writeLocalBindingFixture(space, "fictional-space-retrieval");
  const bindingValue: unknown = JSON.parse(await readFile(bindingPath, "utf8"));
  if (!isJsonObject(bindingValue)) throw new Error("synthetic local binding is not an object");
  bindingValue.write_roots = [space.binding.recordsRoot, presentationRoot];
  await writeFile(bindingPath, JSON.stringify(bindingValue), "utf8");

  const registryPath = join(space.root, "registry.json");
  assert.equal((await registerSpace(registryPath, bindingPath)).ok, true);
  assert.equal((await selectSpace(registryPath, "fictional-space-retrieval", "retrieval-separated-retention-session")).ok, true);

  const writerPaths: string[] = [];
  const writer = async (path: string, content: string): Promise<void> => {
    writerPaths.push(path);
    await writeFile(path, content, "utf8");
  };
  const result = success(await renderPresentation(
    {
      viewId: "project-status",
      audienceId: "supervisor",
      deliveryId: "weekly-markdown",
      model: "fictional-provider/fictional-model",
      generatedAt: "2026-08-05T12:00:00.000Z",
      pack: fictionalPack,
    },
    {
      env: {
        ENGRAM_BINDING_REGISTRY: registryPath,
        ENGRAM_HOST_SESSION_ID: "retrieval-separated-retention-session",
      },
      spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(space.binding.qmdCollectionName, ["status-brief", "risk-note", "recommendation"]) }]).spawnFn,
      writeRetentionFile: writer,
    },
  ));
  if (result.retained === undefined) throw new Error("synthetic retained render did not return retention paths");

  assert.equal(writerPaths.length, 2);
  const directories = [
    ...writerPaths.map((path) => dirname(path)),
    dirname(result.retained.artifactPath),
  ];
  for (const path of writerPaths) assert.equal(pathWithin(authorizedPresentationRoot, path), true, `writer path escaped presentation root: ${path}`);
  for (const directory of directories) {
    assert.equal(pathWithin(authorizedPresentationRoot, directory), true, `retention directory escaped presentation root: ${directory}`);
  }

  // The atomic-publish property: the presentation root contains exactly one
  // entry, named for the presentation id, and no leftover
  // `.engram-presentation-pending-*` mkdtemp directory. Reading `space.root`
  // instead of the presentation root cannot ever see the pending directory
  // (it is created under the presentation root, never under space.root), so
  // that assertion alone cannot fail even with the `rename` promotion
  // deleted entirely. Reading the presentation root and requiring both files
  // to actually be present and readable closes that gap.
  assert.deepEqual(await readdir(authorizedPresentationRoot), [result.receipt.presentationId]);
  const finalDirectory = join(authorizedPresentationRoot, result.receipt.presentationId);
  assert.equal((await stat(finalDirectory)).isDirectory(), true);
  const retainedArtifact = await readFile(result.retained.artifactPath, "utf8");
  assert.ok(retainedArtifact.length > 0, "retained presentation.md must be readable and non-empty");
  const retainedReceipt = await readFile(result.retained.receiptPath, "utf8");
  assert.ok(retainedReceipt.length > 0, "retained receipt.json must be readable and non-empty");
});

test("property: a pack callback that mutates the delivery definition it is handed cannot move whether the presentation is retained, where it is written, or which word limit it is held to", async () => {
  const space = await createEphemeralSpace(RETRIEVAL_RECORDS_DIR, "retrieval-delivery-mutation");
  spacesToClean.push(space);
  const bindingPath = await writeLocalBindingFixture(space, "fictional-space-retrieval");
  const bindingValue: unknown = JSON.parse(await readFile(bindingPath, "utf8"));
  if (!isJsonObject(bindingValue)) throw new Error("synthetic local binding is not an object");
  // Narrow write_roots to the records root only: the presentation root is
  // now genuinely unauthorized, so an honest retained delivery must be
  // refused up front and cannot be reached by accident.
  bindingValue.write_roots = [space.binding.recordsRoot];
  await writeFile(bindingPath, JSON.stringify(bindingValue), "utf8");

  const registryPath = join(space.root, "registry.json");
  assert.equal((await registerSpace(registryPath, bindingPath)).ok, true);
  assert.equal((await selectSpace(registryPath, "fictional-space-retrieval", "retrieval-delivery-mutation-session")).ok, true);
  const env = { ENGRAM_BINDING_REGISTRY: registryPath, ENGRAM_HOST_SESSION_ID: "retrieval-delivery-mutation-session" };
  const collection = space.binding.qmdCollectionName;
  const output = qmdOutput(collection, ["status-brief", "risk-note", "recommendation"]);

  // Baseline: an honest retained delivery is correctly refused because the
  // presentation root is outside the narrowed write boundary.
  const honest = await renderPresentation(
    { viewId: "project-status", audienceId: "supervisor", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-06T00:00:00.000Z", pack: fictionalPack },
    { env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: output }]).spawnFn },
  );
  assert.equal(honest.status, "failed");
  if (honest.status === "failed") assert.ok(honest.errors.some((error) => error.code === "artifact_root_not_writable"));

  const declaredChatBrief = fictionalPack.deliveries.find((delivery) => delivery.id === "chat-brief");
  if (declaredChatBrief === undefined) throw new Error("synthetic chat-brief delivery is missing");
  const beforeSnapshot = JSON.stringify(declaredChatBrief);

  // The unretained `chat-brief` delivery, rendered through an audience whose
  // adapt is handed the delivery definition and tries to flip `retain` on
  // and raise `maxWords`, exactly as any pack callback could. `retain` and
  // `maxWords` are not readonly on DeliveryDefinition, so this is a
  // same-shape assignment, not a cast.
  const longSummary = Array.from({ length: 150 }, (_, index) => `filler${index}`).join(" ");
  const mutatingPack: PresentationPack = {
    ...fictionalPack,
    audiences: [{
      id: "delivery-mutator",
      version: 1,
      authorize: () => true,
      adapt: ({ projection, delivery }) => {
        const writable: { retain: boolean; maxWords: number } = delivery;
        try {
          writable.retain = true;
          writable.maxWords = 100000;
        } catch {
          // A frozen delivery snapshot is expected to reject the attempted mutation.
        }
        return {
          title: projection.title,
          summary: longSummary,
          facts: [...projection.facts],
          uncertainty: [...projection.uncertainty],
          actions: [...projection.actions],
          recommendationIds: [],
        };
      },
    }],
  };

  const mutated = await renderPresentation(
    { viewId: "project-status", audienceId: "delivery-mutator", deliveryId: "chat-brief", model: "fictional-provider/fictional-model", generatedAt: "2026-08-06T00:00:01.000Z", pack: mutatingPack },
    { env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: output }]).spawnFn },
  );

  const retained = mutated.status === "presented" && mutated.retained !== undefined;
  assert.equal(retained, false, "an unretained delivery must not become retained because a callback flipped delivery.retain");
  assert.deepEqual(await readdir(join(space.root, ".engram-presentations")).catch(() => []), []);
  if (mutated.status === "presented") {
    const words = mutated.content.trim().split(/\s+/).filter((word) => word.length > 0).length;
    assert.ok(words <= 60, `rendered content exceeded the declared 60-word delivery limit: ${words} words`);
  }
  assert.equal(
    JSON.stringify(fictionalPack.deliveries.find((delivery) => delivery.id === "chat-brief")),
    beforeSnapshot,
    "a pack callback must not be able to permanently mutate the pack's own delivery object",
  );
});

test("property: the retention boundary resolves symlinks, so a presentation root that resolves inside the records root is refused and the refusal names the resolved path", async () => {
  const space = await createEphemeralSpace(RETRIEVAL_RECORDS_DIR, "retrieval-symlinked-retention");
  spacesToClean.push(space);
  // A symlink where the harness expects its own derived directory, in place
  // BEFORE the space is registered or selected.
  await symlink(space.binding.recordsRoot, join(space.root, ".engram-presentations"));

  const bindingPath = await writeLocalBindingFixture(space, "fictional-space-retrieval");
  const registryPath = join(space.root, "registry.json");
  assert.equal((await registerSpace(registryPath, bindingPath)).ok, true);
  assert.equal((await selectSpace(registryPath, "fictional-space-retrieval", "retrieval-symlinked-retention-session")).ok, true);
  const env = { ENGRAM_BINDING_REGISTRY: registryPath, ENGRAM_HOST_SESSION_ID: "retrieval-symlinked-retention-session" };
  const collection = space.binding.qmdCollectionName;

  const resolvedRecordsRoot = await realpath(space.binding.recordsRoot);
  const before = new Set(await readdir(space.binding.recordsRoot));

  const result = await renderPresentation(
    { viewId: "project-status", audienceId: "supervisor", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-06T00:00:00.000Z", pack: fictionalPack },
    { env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(collection, ["status-brief", "risk-note", "recommendation"]) }]).spawnFn },
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    const segregationError = result.errors.find((error) => error.code === "artifact_root_not_segregated");
    assert.ok(segregationError !== undefined, `expected artifact_root_not_segregated, got ${JSON.stringify(result.errors)}`);
    assert.ok(
      segregationError.message.includes(resolvedRecordsRoot),
      `refusal must name the resolved records root, not the lexical .engram-presentations path: ${segregationError.message}`,
    );
  }

  // Compare against a listing taken before the render, as a set difference —
  // not a `startsWith("presentation-")` filter, which the fixture's
  // pre-existing presentation-source.md record would trip even when nothing
  // leaked.
  const after = new Set(await readdir(space.binding.recordsRoot));
  const leaked = [...after].filter((entry) => !before.has(entry));
  assert.deepEqual(leaked, [], `records root gained unexpected entries: ${leaked.join(", ")}`);
});

test("property: invalid inputs, retrieval failure, authorization failure, and retention failure produce no successful or partial presentation", async () => {
  const context = await makeContext();
  const invalidCases = [
    { viewId: "missing-view", audienceId: "supervisor", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model" },
    { viewId: "project-status", audienceId: "missing-audience", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model" },
    { viewId: "project-status", audienceId: "supervisor", deliveryId: "missing-delivery", model: "fictional-provider/fictional-model" },
    { viewId: "project-status", audienceId: "supervisor", deliveryId: "weekly-markdown", model: "fictional-provider/not-allowed" },
  ];
  for (const invalid of invalidCases) {
    const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief"]) }]);
    const result = await renderPresentation({ ...invalid, pack: fictionalPack }, { env: context.env, spawnFn: scripted.spawnFn });
    assert.equal(result.status, "failed");
    assert.equal(scripted.calls.length, 0);
  }

  const qmdFailed = await renderPresentation(
    { viewId: "project-status", audienceId: "supervisor", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", pack: fictionalPack },
    { env: context.env, spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 2, stderr: "synthetic qmd failure" }]).spawnFn },
  );
  assert.equal(qmdFailed.status, "failed");
  const writeFailed = await renderPresentation(
    { viewId: "project-status", audienceId: "supervisor", deliveryId: "weekly-markdown", model: "fictional-provider/fictional-model", generatedAt: "2026-08-05T12:00:00.000Z", pack: fictionalPack },
    {
      env: context.env,
      spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: qmdOutput(context.collection, ["status-brief", "risk-note", "recommendation"]) }]).spawnFn,
      writeRetentionFile: async () => { throw new Error("synthetic artifact write failure"); },
    },
  );
  assert.equal(writeFailed.status, "failed");
  assert.doesNotMatch(JSON.stringify(writeFailed), /The beacon project remains on track/);
  assert.deepEqual(await readdir(join(context.space.root, ".engram-presentations")), []);
});

test("property: the provisional CLI exposes recall and render without space, root, collection, or output-root overrides", async () => {
  const context = await makeContext();
  const commands = [
    [CLI_PATH, "recall", "--query", "beacon", "--audience", "supervisor"],
    [CLI_PATH, "render", "--view", "project-status", "--audience", "supervisor", "--delivery", "weekly-markdown", "--model", "fictional-provider/fictional-model"],
  ];
  for (const command of commands) {
    const result = await execFileAsync(process.execPath, command, { env: { ...process.env, ...context.env } }).catch((error: unknown) => {
      const detail = error instanceof Error
        ? `${error.message} ${JSON.stringify(error)}`
        : String(error);
      throw new Error(`CLI ${command[1] ?? "command"} failed in the synthetic environment: ${detail}`);
    });
    assert.match(result.stdout, /schema_version/);
    for (const override of ["--space", "--root", "--collection", "--output-root"]) {
      await assert.rejects(execFileAsync(process.execPath, [...command, override, "synthetic-override"], {
        env: { ...process.env, ...context.env },
      }));
    }
  }
});
