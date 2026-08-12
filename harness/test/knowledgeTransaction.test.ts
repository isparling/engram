import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AtomicWriteDirectorySyncError, atomicWriteFile } from "../src/atomicWrite.ts";
import { fictionalPack } from "../test/fictionalPack.ts";
import {
  applyKnowledgeProposal,
  reconcileKnowledgeTransaction,
  submitKnowledgeCandidate,
  transactionLockDirectory,
  type ApplyKnowledgeInput,
  type KnowledgeProposal,
} from "../src/knowledgeTransaction.ts";
import { parseKnowledgeRecord, serializeKnowledgeRecord } from "../src/knowledgeRecord.ts";
import { retrieveRelatedRecords } from "../src/knowledgeRetrieval.ts";
import { acquireTransactionLock } from "../src/transactionLock.ts";
import { runQmd } from "../src/qmdRunner.ts";
import type {
  KnowledgePack,
  KnowledgeRecord,
  KnowledgeResult,
  PackReconciliation,
} from "../src/knowledgeTypes.ts";
import type { ActiveSpace } from "../src/spaceRegistry.ts";
import { makeAlwaysSucceedsSpawnFn, makeScriptedSpawnFn } from "./fakes.ts";
import {
  createEphemeralSpace,
  destroyEphemeralSpace,
  FIXTURES_DIR,
  type EphemeralSpace,
} from "./testSupport.ts";

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const CLI = join(HARNESS_DIR, "src", "cli.ts");
const TRANSACTION_A_RECORDS_DIR = join(FIXTURES_DIR, "transaction-space-a", "records");
const TRANSACTION_B_RECORDS_DIR = join(FIXTURES_DIR, "transaction-space-b", "records");
const spacesToClean: EphemeralSpace[] = [];

after(async () => {
  for (const space of spacesToClean) await destroyEphemeralSpace(space);
});

async function makeSpace(
  fixtureRecordsDir = TRANSACTION_A_RECORDS_DIR,
  collectionName = `transaction-space-${spacesToClean.length}`,
  spaceId = fixtureRecordsDir === TRANSACTION_B_RECORDS_DIR ? "fictional-space-transaction-b" : "fictional-space-transaction-a",
): Promise<{ space: EphemeralSpace; active: ActiveSpace }> {
  const space = await createEphemeralSpace(fixtureRecordsDir, collectionName);
  spacesToClean.push(space);
  const active: ActiveSpace = {
    ...space.binding,
    spaceId,
    spaceRoot: space.root,
    manifestPath: join(space.root, "space.json"),
    bindingPath: join(space.root, "binding.json"),
    sessionsDir: join(space.root, "sessions"),
    readRoots: [space.root],
    writeRoots: [space.root],
    allowedModels: ["synthetic-provider/synthetic-model"],
    credentialEnv: [],
    knowledgeSchemaVersion: "0",
    packs: [{ id: fictionalPack.id, version: fictionalPack.version }],
  };
  return { space, active };
}

function candidate(
  disposition: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "orbit-revised",
    kind: "claim",
    status: "candidate",
    statement: "The orbit service's staged rollout does not prevent replay during a routine release.",
    details: { basis: "synthetic-observation", certainty: "provisional", related_phrase: "staged rollout prevents replay" },
    scope: {
      space: "fictional-space-transaction-a",
      subjects: ["subject:orbit"],
      topics: ["topic:release"],
      contexts: ["context:cycle-alpha"],
      dimensions: { signals: ["signal:staged-rollout"] },
    },
    pack: { id: fictionalPack.id, version: fictionalPack.version },
    sources: [{ type: "observation", ref: "source:orbit-revision" }],
    session: { id: "synthetic-session-a", host: "synthetic-host" },
    submitted_at: "2026-08-05",
    disposition,
    ...overrides,
  };
}

function hitUri(active: ActiveSpace, relativePath = "orbit-claim.md"): string {
  return `qmd://${active.qmdCollectionName}/${relativePath}`;
}

function hitOutput(active: ActiveSpace, relativePath = "orbit-claim.md", snippet = "stale qmd snippet"): string {
  return JSON.stringify([
    {
      docid: "stale-document-id",
      score: 999,
      file: hitUri(active, relativePath),
      title: "hostile stale title",
      snippet,
      body: "hostile qmd body must never reach the pack",
    },
  ]);
}

function proposalOf(outcome: Awaited<ReturnType<typeof reconcileKnowledgeTransaction>>): KnowledgeProposal {
  assert.equal(outcome.status, "proposal");
  if (outcome.status !== "proposal") throw new Error("expected proposal");
  return outcome.proposal;
}

async function reconcileWithHit(
  active: ActiveSpace,
  input: unknown,
  snippet = "stale qmd snippet",
): Promise<{ proposal: KnowledgeProposal; calls: ReturnType<typeof makeScriptedSpawnFn>["calls"] }> {
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: hitOutput(active, "orbit-claim.md", snippet) }]);
  const outcome = await reconcileKnowledgeTransaction({
    binding: active,
    candidateInput: input,
    pack: fictionalPack,
    spawnFn: scripted.spawnFn,
  });
  return { proposal: proposalOf(outcome), calls: scripted.calls };
}

async function reconcileWithMiss(
  active: ActiveSpace,
  input: unknown,
  stdout = "[]",
): Promise<{ proposal: KnowledgeProposal; calls: ReturnType<typeof makeScriptedSpawnFn>["calls"] }> {
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout }]);
  const outcome = await reconcileKnowledgeTransaction({
    binding: active,
    candidateInput: input,
    pack: fictionalPack,
    spawnFn: scripted.spawnFn,
  });
  return { proposal: proposalOf(outcome), calls: scripted.calls };
}

function applyInput(
  active: ActiveSpace,
  proposal: KnowledgeProposal,
  decision: ApplyKnowledgeInput["decision"],
  expectedPlanHash: string,
  extras: Partial<ApplyKnowledgeInput> = {},
): ApplyKnowledgeInput {
  return {
    binding: active,
    proposal,
    decision,
    expectedPlanHash,
    pack: fictionalPack,
    ...extras,
  };
}

test("submission of a valid envelope is inert: active Markdown and qmd results remain unchanged", async () => {
  const { active } = await makeSpace();
  const recordPath = join(active.recordsRoot, "orbit-claim.md");
  const beforeBytes = await readFile(recordPath);
  const beforeSearch = await import("../src/qmdRunner.ts").then(({ runQmd }) =>
    runQmd(["search", "staged rollout prevents replay", "--json", "-c", active.qmdCollectionName], active),
  );

  const submitted = submitKnowledgeCandidate({
    binding: active,
    candidateInput: candidate("new"),
    pack: fictionalPack,
  });

  assert.equal(submitted.status, "submitted");
  const afterBytes = await readFile(recordPath);
  const afterSearch = await import("../src/qmdRunner.ts").then(({ runQmd }) =>
    runQmd(["search", "staged rollout prevents replay", "--json", "-c", active.qmdCollectionName], active),
  );
  assert.deepEqual(afterBytes, beforeBytes);
  assert.equal(afterSearch.code, beforeSearch.code);
  assert.equal(afterSearch.stdout, beforeSearch.stdout);
  assert.equal(afterSearch.stderr, beforeSearch.stderr);
  // The submission boundary accepts no qmd or write callback at all; reaching
  // this result therefore proves the qmd/write tail was not entered.
});

test("invalid pack, source, session, scope, state, kind, disposition, newline, and unknown envelope fields fail before retrieval", async () => {
  const { active } = await makeSpace();
  const recordPath = join(active.recordsRoot, "orbit-claim.md");
  const before = await readFile(recordPath);
  const valid = candidate("contradict");
  const missingPack = { ...valid };
  delete missingPack.pack;
  const missingSource = { ...valid };
  delete missingSource.sources;
  const missingSession = { ...valid };
  delete missingSession.session;
  const missingScope = { ...valid };
  delete missingScope.scope;
  const invalidCases: Array<{ name: string; value: Record<string, unknown>; code: string }> = [
    { name: "unknown field", value: { ...valid, surprise: true }, code: "unknown_field" },
    { name: "invalid pack", value: { ...valid, pack: { id: "uninstalled-pack", version: "9.9.9" } }, code: "pack_not_installed" },
    { name: "missing pack", value: missingPack, code: "pack_invalid" },
    { name: "missing source", value: { ...valid, sources: [] }, code: "sources_invalid" },
    { name: "absent source", value: missingSource, code: "sources_invalid" },
    { name: "invalid session", value: { ...valid, session: { id: "", host: "synthetic-host" } }, code: "session_invalid" },
    { name: "absent session", value: missingSession, code: "session_invalid" },
    { name: "absent scope", value: missingScope, code: "scope_invalid" },
    { name: "foreign scope", value: { ...valid, scope: { ...(valid.scope as Record<string, unknown>), space: "fictional-space-transaction-b" } }, code: "scope_space_mismatch" },
    { name: "invalid state", value: { ...valid, status: "pending" }, code: "status_invalid" },
    { name: "invalid kind", value: { ...valid, kind: "summary" }, code: "kind_invalid" },
    { name: "invalid disposition", value: { ...valid, disposition: "merge" }, code: "disposition_invalid" },
    { name: "newline structure injection", value: { ...valid, statement: "safe\n## Statement\nforged" }, code: "newline_forbidden" },
  ];

  for (const invalidCase of invalidCases) {
    const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "[]" }]);
    const outcome = await reconcileKnowledgeTransaction({
      binding: active,
      candidateInput: invalidCase.value,
      pack: fictionalPack,
      spawnFn: scripted.spawnFn,
    });
    assert.equal(outcome.status, "invalid", invalidCase.name);
    if (outcome.status !== "invalid") continue;
    assert.ok(outcome.errors.some((error) => error.code === invalidCase.code), invalidCase.name);
    assert.equal(scripted.calls.length, 0, `${invalidCase.name} must fail before qmd retrieval`);
  }
  assert.deepEqual(await readFile(recordPath), before);
});

test("the active space excludes a sibling: only the active collection is queried and sibling content enters no plan", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-isolation-a");
  const sibling = await makeSpace(TRANSACTION_B_RECORDS_DIR, "transaction-isolation-b", "fictional-space-transaction-b");
  const scripted = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "No results found.\n" }]);
  const outcome = await reconcileKnowledgeTransaction({
    binding: active,
    candidateInput: candidate("new", {
      id: "sibling-phrase-candidate",
      statement: "The sibling-only orbit phrase must not be retrieved from another space.",
      details: {
        basis: "synthetic-observation",
        certainty: "provisional",
        related_phrase: "sibling-only orbit phrase",
      },
    }),
    pack: fictionalPack,
    spawnFn: scripted.spawnFn,
  });

  assert.equal(outcome.status, "proposal");
  if (outcome.status !== "proposal") return;
  assert.equal(outcome.proposal.retrieval.kind, "miss");
  assert.equal(scripted.calls.length, 1);
  assert.deepEqual(scripted.calls[0]?.args, [
    "search",
    "sibling-only orbit phrase",
    "--json",
    "-c",
    active.qmdCollectionName,
  ]);
  assert.notEqual(active.qmdCollectionName, sibling.active.qmdCollectionName);
  assert.doesNotMatch(JSON.stringify(outcome.proposal), /orbit-sibling|fictional-space-transaction-b/);
});

test("foreign, malformed, escaped, nonzero, and invalid-current qmd results fail closed without a mutation plan", async () => {
  const cases: Array<{ name: string; stdout: string; code: number; stderr?: string; corruptCurrent?: boolean }> = [
    { name: "foreign collection locator", stdout: JSON.stringify([{ file: "qmd://transaction-other/orbit-claim.md" }]), code: 0 },
    { name: "path escape", stdout: JSON.stringify([{ file: "qmd://transaction-retrieval-a/../outside.md" }]), code: 0 },
    { name: "malformed JSON", stdout: "[{", code: 0 },
    { name: "malformed hit shape", stdout: JSON.stringify([{ docid: "only-a-docid" }]), code: 0 },
    { name: "qmd nonzero exit", stdout: "[]", code: 2, stderr: "synthetic qmd failure" },
    { name: "invalid current Markdown", stdout: JSON.stringify([{ file: "qmd://transaction-retrieval-invalid/orbit-claim.md" }]), code: 0, corruptCurrent: true },
  ];

  for (const failureCase of cases) {
    const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, `transaction-retrieval-${spacesToClean.length}`);
    const collection = active.qmdCollectionName;
    const stdout = failureCase.name === "foreign collection locator"
      ? failureCase.stdout
      : failureCase.stdout.replace(/transaction-retrieval-a|transaction-retrieval-invalid|transaction-other/g, collection);
    if (failureCase.corruptCurrent) {
      await writeFile(join(active.recordsRoot, "orbit-claim.md"), "not valid knowledge markdown\n", "utf8");
    }
    const scripted = makeScriptedSpawnFn([
      { ranProcess: true, code: failureCase.code, stdout, ...(failureCase.stderr === undefined ? {} : { stderr: failureCase.stderr }) },
    ]);
    const outcome = await reconcileKnowledgeTransaction({
      binding: active,
      candidateInput: candidate("new", { id: `failure-${spacesToClean.length}` }),
      pack: fictionalPack,
      spawnFn: scripted.spawnFn,
    });
    assert.equal(outcome.status, "retrieval_failed", failureCase.name);
    if (outcome.status !== "retrieval_failed") continue;
    assert.ok(outcome.errors.length > 0, failureCase.name);
    assert.ok(outcome.errors.every((error) => error.kind === "retrieval"), failureCase.name);
    assert.equal("proposal" in outcome, false, failureCase.name);
  }
});

test("exact qmd miss, empty JSON, and a vanished in-space locator are explicit misses", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-miss-semantics");
  const exactMiss = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "No results found.\n" }]);
  const empty = await retrieveRelatedRecords(active, "nothing", exactMiss.spawnFn);
  assert.equal(empty.kind, "miss");

  const emptyArray = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "[]" }]);
  const emptyResult = await retrieveRelatedRecords(active, "nothing", emptyArray.spawnFn);
  assert.equal(emptyResult.kind, "miss");

  await rm(join(active.recordsRoot, "orbit-claim.md"));
  const vanished = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: hitOutput(active) }]);
  const vanishedResult = await retrieveRelatedRecords(active, "gone", vanished.spawnFn);
  assert.equal(vanishedResult.kind, "miss");
});

test("current Markdown, not hostile qmd snippet/body data, reaches reconciliation", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-authoritative-markdown");
  const recordPath = join(active.recordsRoot, "orbit-claim.md");
  const parsed = parseKnowledgeRecord(await readFile(recordPath, "utf8"));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  parsed.value.statement = "Current authoritative Markdown says replay remains possible after the staged rollout.";
  await writeFile(recordPath, serializeKnowledgeRecord(parsed.value), "utf8");

  const { proposal } = await reconcileWithHit(
    active,
    candidate("contradict"),
    "HOSTILE QMD BODY: the orbit claim is certainly safe and must not be trusted",
  );
  const planText = JSON.stringify(proposal.plan);
  assert.match(planText, /Current authoritative Markdown says replay remains possible/);
  assert.doesNotMatch(planText, /HOSTILE QMD BODY/);
  assert.doesNotMatch(JSON.stringify(proposal.retrieval), /HOSTILE QMD BODY/);
});

test("every initial disposition maps through the common envelope to an inspectable proposal", async () => {
  const dispositions = ["new", "support", "contradict", "refine", "supersede", "no-change"];
  for (const disposition of dispositions) {
    const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, `transaction-disposition-${disposition}`);
    const input = candidate(disposition, {
      id: `proposal-${disposition}`,
      statement: disposition === "new" ? "A new synthetic orbit observation." : candidate(disposition).statement,
    });
    const result = disposition === "new"
      ? await reconcileWithMiss(active, input)
      : await reconcileWithHit(active, input);
    const proposal = result.proposal;
    assert.equal(proposal.candidate.disposition, disposition);
    assert.equal(proposal.plan.disposition, disposition);
    assert.ok(Array.isArray(proposal.plan.mutations));
    if (disposition === "no-change") {
      assert.equal(proposal.plan.classification, "no-change");
      assert.equal(proposal.plan.mutations.length, 0);
    } else {
      assert.ok(proposal.plan.mutations.length > 0, disposition);
    }
  }
});

test("the complete contradiction plan precedes approval; rejection changes neither Markdown nor qmd state", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-reject-contradiction");
  const { proposal } = await reconcileWithHit(active, candidate("contradict"));
  assert.equal(proposal.plan.classification, "non-additive");
  assert.equal(proposal.plan.mutations.length, 2);
  assert.deepEqual(
    proposal.plan.mutations.map((mutation) => mutation.recordId).sort(),
    ["orbit-claim", "orbit-revised"],
  );
  assert.ok(proposal.plan.mutations.every((mutation) => mutation.path.startsWith(active.recordsRoot)));
  assert.match(JSON.stringify(proposal.plan), /contradicts/);

  const oldPath = join(active.recordsRoot, "orbit-claim.md");
  const before = await readFile(oldPath);
  const qmdBefore = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "No results found.\n" }]);
  const qmdStateBefore = await runQmd(
    ["search", "staged rollout prevents replay", "--json", "-c", active.qmdCollectionName],
    active,
    qmdBefore.spawnFn,
  );
  const rejectedQmd = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "should not run" }]);
  const rejected = await applyKnowledgeProposal(
    applyInput(active, proposal, "reject", proposal.plan_hash, { spawnFn: rejectedQmd.spawnFn }),
  );
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.refresh.count, 0);
  assert.equal(rejectedQmd.calls.length, 0);
  assert.deepEqual(await readFile(oldPath), before);
  assert.equal(await readFile(join(active.recordsRoot, "orbit-revised.md")).catch(() => null), null);
  const qmdAfter = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "No results found.\n" }]);
  const qmdStateAfter = await runQmd(
    ["search", "staged rollout prevents replay", "--json", "-c", active.qmdCollectionName],
    active,
    qmdAfter.spawnFn,
  );
  assert.equal(qmdStateAfter.code, qmdStateBefore.code);
  assert.equal(qmdStateAfter.stdout, qmdStateBefore.stdout);
  assert.equal(qmdStateAfter.stderr, qmdStateBefore.stderr);
});

test("the core rejects a pack update that deletes existing relationship or history trace", async () => {
  const tracePack: KnowledgePack = {
    id: "trace-pack",
    version: "0.1.0",
    validateEnvelope: (envelope): KnowledgeResult<void> => {
      if (envelope.details.marker !== "trace-pack") {
        return { ok: false, errors: [{ kind: "validation", code: "trace_pack_details", message: "trace pack marker required" }] };
      }
      return { ok: true, value: undefined };
    },
    relatedQuery: (envelope) => envelope.statement,
    reconcile: ({ candidate: submitted, related }): KnowledgeResult<PackReconciliation> => {
      const current = related[0];
      if (current === undefined) {
        return { ok: false, errors: [{ kind: "plan", code: "trace_related_required", message: "trace pack needs a related record" }] };
      }
      return {
        ok: true,
        value: {
          disposition: submitted.disposition,
          summary: "trace pack attempts to erase prior history",
          mutations: [{
            action: "update",
            record: {
              ...current,
              pack: submitted.pack,
              status: "candidate",
              relationships: { supports: [], contradicts: [], refines: [], supersedes: [] },
              history: [],
            },
          }],
        },
      };
    },
  };
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-core-trace-preservation");
  const traceActive: ActiveSpace = { ...active, packs: [{ id: tracePack.id, version: tracePack.version }] };
  const recordPath = join(traceActive.recordsRoot, "orbit-claim.md");
  const parsed = parseKnowledgeRecord(await readFile(recordPath, "utf8"));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  parsed.value.relationships.supports = ["orbit-support"];
  parsed.value.history = [{ event: "seeded-trace", relatedId: "orbit-support", submittedAt: "2026-08-02" }];
  await writeFile(recordPath, serializeKnowledgeRecord(parsed.value), "utf8");

  const outcome = await reconcileKnowledgeTransaction({
    binding: traceActive,
    candidateInput: candidate("refine", {
      id: "trace-candidate",
      pack: { id: tracePack.id, version: tracePack.version },
      details: { marker: "trace-pack" },
    }),
    pack: tracePack,
    spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: hitOutput(traceActive) }]).spawnFn,
  });
  assert.equal(outcome.status, "invalid");
  if (outcome.status !== "invalid") return;
  assert.ok(outcome.errors.some((error) => error.code === "record_trace_loss"));
});

test("property: an existing update cannot erase or change sources, session, or scope provenance", async () => {
  const provenancePack: KnowledgePack = {
    id: "provenance-pack",
    version: "0.1.0",
    validateEnvelope: (envelope): KnowledgeResult<void> => {
      if (envelope.details.marker !== "provenance-pack") {
        return { ok: false, errors: [{ kind: "validation", code: "provenance_pack_details", message: "provenance pack marker required" }] };
      }
      return { ok: true, value: undefined };
    },
    relatedQuery: (envelope) => envelope.statement,
    reconcile: ({ candidate: submitted, related }): KnowledgeResult<PackReconciliation> => {
      const current = related[0];
      if (current === undefined) {
        return { ok: false, errors: [{ kind: "plan", code: "provenance_related_required", message: "provenance pack needs a related record" }] };
      }
      return {
        ok: true,
        value: {
          disposition: submitted.disposition,
          summary: "provenance pack attempts to change established provenance",
          mutations: [{
            action: "update",
            record: {
              ...current,
              pack: submitted.pack,
              sources: [{ type: "synthetic-replacement", ref: "source:erased" }],
              session: { id: "synthetic-other-session", host: "synthetic-other-host" },
              scope: { ...current.scope, subjects: ["subject:other"], contexts: ["context:other"] },
            },
          }],
        },
      };
    },
  };
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-provenance-preservation");
  const provenanceActive: ActiveSpace = { ...active, packs: [{ id: provenancePack.id, version: provenancePack.version }] };
  const outcome = await reconcileKnowledgeTransaction({
    binding: provenanceActive,
    candidateInput: candidate("refine", {
      id: "provenance-candidate",
      pack: { id: provenancePack.id, version: provenancePack.version },
      details: { marker: "provenance-pack" },
    }),
    pack: provenancePack,
    spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: hitOutput(provenanceActive) }]).spawnFn,
  });
  assert.equal(outcome.status, "invalid");
  if (outcome.status !== "invalid") return;
  assert.ok(outcome.errors.some((error) => error.code === "record_trace_loss"));
});

async function replaceRecordWithOutsideSymlink(active: ActiveSpace, recordId: string, content: string): Promise<string> {
  const outsidePath = join(active.spaceRoot, `synthetic-outside-${recordId}.md`);
  const targetPath = join(active.recordsRoot, `${recordId}.md`);
  await writeFile(outsidePath, content, "utf8");
  await rm(targetPath);
  await symlink(outsidePath, targetPath);
  return outsidePath;
}

function assertPathEscapeFailure(errors: Array<{ code: string }>): void {
  assert.ok(errors.some((error) => error.code === "path_escape" || error.code === "protected_path"));
}

test("property: replacing a related record with an outside symlink before reconciliation planning cannot enter the plan", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-symlink-before-plan");
  const original = await readFile(join(active.recordsRoot, "orbit-claim.md"), "utf8");
  const outcome = await reconcileKnowledgeTransaction({
    binding: active,
    candidateInput: candidate("contradict"),
    pack: fictionalPack,
    spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: hitOutput(active) }]).spawnFn,
    beforePlanBuild: async () => {
      await replaceRecordWithOutsideSymlink(active, "orbit-claim", original);
    },
  });
  assert.equal(outcome.status, "invalid");
  if (outcome.status !== "invalid") return;
  assertPathEscapeFailure(outcome.errors);
  assert.equal((await lstat(join(active.recordsRoot, "orbit-claim.md"))).isSymbolicLink(), true);
  assert.doesNotMatch(JSON.stringify(outcome), /synthetic-outside-orbit-claim/);
});

test("property: replacing a planned record with an outside symlink after preview cannot commit or refresh", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-symlink-after-preview");
  const { proposal } = await reconcileWithHit(active, candidate("contradict"));
  const oldMutation = proposal.plan.mutations.find((mutation) => mutation.recordId === "orbit-claim");
  assert.notEqual(oldMutation, undefined);
  if (oldMutation === undefined || oldMutation.beforeText === null) return;
  await replaceRecordWithOutsideSymlink(active, "orbit-claim", oldMutation.beforeText);

  const qmd = makeAlwaysSucceedsSpawnFn("must not run");
  const outcome = await applyKnowledgeProposal(
    applyInput(active, proposal, "approve", proposal.plan_hash, { spawnFn: qmd.spawnFn }),
  );
  assert.equal(outcome.status, "invalid");
  if (outcome.status !== "invalid") return;
  assertPathEscapeFailure(outcome.errors);
  assert.equal(qmd.calls.length, 0);
  assert.equal((await lstat(join(active.recordsRoot, "orbit-claim.md"))).isSymbolicLink(), true);
  assert.equal(await readFile(join(active.recordsRoot, "orbit-revised.md")).catch(() => null), null);
});

test("property: a related record rewritten after retrieval but before the authoritative comparison fails the transaction closed", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-related-record-race");
  const recordPath = join(active.recordsRoot, "orbit-claim.md");
  const parsed = parseKnowledgeRecord(await readFile(recordPath, "utf8"));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  parsed.value.statement = "Rewritten mid-flight: this must never reach a mutation plan built on the stale retrieved copy.";
  const rewritten = serializeKnowledgeRecord(parsed.value);

  const outcome = await reconcileKnowledgeTransaction({
    binding: active,
    candidateInput: candidate("contradict"),
    pack: fictionalPack,
    spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: hitOutput(active) }]).spawnFn,
    afterRetrieval: async () => {
      await writeFile(recordPath, rewritten, "utf8");
    },
  });

  assert.equal(outcome.status, "invalid");
  if (outcome.status !== "invalid") return;
  assert.ok(outcome.errors.some((error) => error.code === "related_record_changed"), JSON.stringify(outcome.errors));
  assert.equal("proposal" in outcome, false);
  assert.equal(await readFile(recordPath, "utf8"), rewritten);
});

test("property: refine and supersede relationships point from the new record to the old record only", async () => {
  const { active: refineActive } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-direction-refine");
  const refineOutcome = await reconcileKnowledgeTransaction({
    binding: refineActive,
    candidateInput: candidate("refine"),
    pack: fictionalPack,
    spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: hitOutput(refineActive) }]).spawnFn,
  });
  const refine = proposalOf(refineOutcome);
  const refineOld = refine.plan.mutations.find((mutation) => mutation.recordId === "orbit-claim");
  const refineNew = refine.plan.mutations.find((mutation) => mutation.recordId === "orbit-revised");
  assert.notEqual(refineNew, undefined);
  if (refineNew === undefined) return;
  assert.ok(refineNew.after.relationships.refines.includes("orbit-claim"));
  assert.equal(refineOld === undefined || !refineOld.after.relationships.refines.includes("orbit-revised"), true);

  const { active: supersedeActive } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-direction-supersede");
  const supersedeOutcome = await reconcileKnowledgeTransaction({
    binding: supersedeActive,
    candidateInput: candidate("supersede"),
    pack: fictionalPack,
    spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: hitOutput(supersedeActive) }]).spawnFn,
  });
  const supersede = proposalOf(supersedeOutcome);
  const supersedeOld = supersede.plan.mutations.find((mutation) => mutation.recordId === "orbit-claim");
  const supersedeNew = supersede.plan.mutations.find((mutation) => mutation.recordId === "orbit-revised");
  assert.notEqual(supersedeOld, undefined);
  assert.notEqual(supersedeNew, undefined);
  if (supersedeOld === undefined || supersedeNew === undefined) return;
  assert.equal(supersedeOld.after.status, "retired");
  assert.ok(supersedeOld.after.history.some((entry) => entry.event === "superseded-by" && entry.relatedId === "orbit-revised"));
  assert.equal(supersedeOld.after.relationships.supersedes.includes("orbit-revised"), false);
  assert.ok(supersedeNew.after.relationships.supersedes.includes("orbit-claim"));
});

test("property: two concurrent stale-lock recoveries allow one transaction and preserve the winner", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-exclusive-stale-recovery");
  const { proposal } = await reconcileWithMiss(active, candidate("new", { id: "exclusive-recovery-candidate" }));
  const lockPath = transactionLockDirectory(active);
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ schema_version: 0, pid: 99999999, hostname: hostname(), token: "stale-owner" }),
    "utf8",
  );

  let winnerInWrite: (() => void) | undefined;
  const winnerWriting = new Promise<void>((resolve) => {
    winnerInWrite = resolve;
  });
  let releaseWinnerWrite: (() => void) | undefined;
  const winnerGate = new Promise<void>((resolve) => {
    releaseWinnerWrite = resolve;
  });
  const winnerWrite = async (path: string, content: string): Promise<void> => {
    winnerInWrite?.();
    await winnerGate;
    await atomicWriteFile(path, content);
  };
  const winnerQmd = makeAlwaysSucceedsSpawnFn("winner refresh");
  const loserQmd = makeAlwaysSucceedsSpawnFn("loser must not refresh");
  const winner = applyKnowledgeProposal(applyInput(active, proposal, "approve", proposal.plan_hash, {
    writeRecord: winnerWrite,
    spawnFn: winnerQmd.spawnFn,
    transactionLockHooks: { afterExistingOwnerRead: async () => {} },
  }));
  const loser = applyKnowledgeProposal(applyInput(active, proposal, "approve", proposal.plan_hash, {
    spawnFn: loserQmd.spawnFn,
    transactionLockHooks: { afterExistingOwnerRead: async () => { await winnerWriting; } },
  }));

  await winnerWriting;
  const loserResult = await loser;
  const winnerLockRemained = await lstat(lockPath).then(() => true).catch(() => false);
  let winnerToken: string | undefined;
  if (winnerLockRemained) {
    const owner: unknown = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    if (typeof owner === "object" && owner !== null && !Array.isArray(owner) && "token" in owner && typeof owner.token === "string") winnerToken = owner.token;
  }
  releaseWinnerWrite?.();
  const winnerResult = await winner;
  assert.equal(winnerResult.status, "committed");
  assert.equal(loserResult.status, "lock_conflict");
  assert.equal(winnerQmd.calls.length, 1);
  assert.equal(loserQmd.calls.length, 0);
  assert.equal(winnerLockRemained, true);
  assert.equal(typeof winnerToken, "string");
});

test("property: ownership changes during stale recovery fail closed without removing the changed owner", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-owner-changes-during-recovery");
  const lockPath = transactionLockDirectory(active);
  const ownerPath = join(lockPath, "owner.json");
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    ownerPath,
    JSON.stringify({ schema_version: 0, pid: 99999999, hostname: hostname(), token: "stale-owner" }),
    "utf8",
  );
  const changedOwner = { schema_version: 0, pid: 99999999, hostname: hostname(), token: "changed-owner" };
  const result = await acquireTransactionLock(active, {
    afterExistingOwnerRead: async () => {
      await writeFile(ownerPath, JSON.stringify(changedOwner), "utf8");
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.code === "lock_conflict" || error.code === "lock_recovery_failed"));
  assert.deepEqual(JSON.parse(await readFile(ownerPath, "utf8")), changedOwner);
});

test("approval of a different candidate, space, binding, source record, related record, or date is stale", async () => {
  const variants: Array<{ name: string; change: (active: ActiveSpace, proposal: KnowledgeProposal) => Promise<{ active: ActiveSpace; candidateInput?: unknown }> }> = [
    {
      name: "different candidate",
      change: async (active) => ({ active, candidateInput: candidate("contradict", { statement: "A different revised statement." }) }),
    },
    {
      name: "changed source record",
      change: async (active) => {
        const path = join(active.recordsRoot, "orbit-claim.md");
        const parsed = parseKnowledgeRecord(await readFile(path, "utf8"));
        if (!parsed.ok) throw new Error("fixture did not parse");
        parsed.value.statement = "The authoritative source record changed after preview.";
        await writeFile(path, serializeKnowledgeRecord(parsed.value), "utf8");
        return { active };
      },
    },
    {
      name: "changed related record",
      change: async (active) => {
        const path = join(active.recordsRoot, "orbit-claim.md");
        const parsed = parseKnowledgeRecord(await readFile(path, "utf8"));
        if (!parsed.ok) throw new Error("fixture did not parse");
        parsed.value.details = { basis: "changed-related-record", certainty: "provisional" };
        await writeFile(path, serializeKnowledgeRecord(parsed.value), "utf8");
        return { active };
      },
    },
    {
      name: "changed binding",
      change: async (active) => ({ active: { ...active, qmdCollectionName: `${active.qmdCollectionName}-changed` } }),
    },
    {
      name: "changed submission date",
      change: async (active) => ({ active, candidateInput: candidate("contradict", { submitted_at: "2026-08-06" }) }),
    },
    {
      name: "another space",
      change: async () => {
        const other = await makeSpace(TRANSACTION_B_RECORDS_DIR, `transaction-other-space-${spacesToClean.length}`, "fictional-space-transaction-b");
        return { active: other.active };
      },
    },
  ];

  for (const variant of variants) {
    const { active: original } = await makeSpace(TRANSACTION_A_RECORDS_DIR, `transaction-stale-${spacesToClean.length}`);
    const { proposal } = await reconcileWithHit(original, candidate("contradict"));
    const changed = await variant.change(original, proposal);
    const fake = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "must not refresh" }]);
    const outcome = await applyKnowledgeProposal(
      applyInput(changed.active, proposal, "approve", proposal.plan_hash, {
        candidateInput: changed.candidateInput,
        spawnFn: fake.spawnFn,
      }),
    );
    assert.equal(outcome.status, "stale_approval", variant.name);
    assert.equal(fake.calls.length, 0, `${variant.name} must not refresh`);
  }
});

test("approval preserves the old record, relationships, provenance, and reports one fresh qmd pass", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-approve-contradiction");
  const { proposal } = await reconcileWithHit(active, candidate("contradict"));
  const qmd = makeAlwaysSucceedsSpawnFn("Indexed: 2 new, 0 updated, 0 unchanged, 0 removed");
  const result = await applyKnowledgeProposal(
    applyInput(active, proposal, "approve", proposal.plan_hash, { spawnFn: qmd.spawnFn }),
  );
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.equal(result.refresh.count, 1);
  assert.equal(result.refresh.state, "fresh");
  assert.equal(qmd.calls.length, 1);

  const old = parseKnowledgeRecord(await readFile(join(active.recordsRoot, "orbit-claim.md"), "utf8"));
  const revised = parseKnowledgeRecord(await readFile(join(active.recordsRoot, "orbit-revised.md"), "utf8"));
  assert.equal(old.ok, true);
  assert.equal(revised.ok, true);
  if (!old.ok || !revised.ok) return;
  assert.equal(old.value.status, "contested");
  assert.equal(revised.value.status, "active");
  assert.ok(old.value.relationships.contradicts.includes("orbit-revised"));
  assert.ok(revised.value.relationships.contradicts.includes("orbit-claim"));
  assert.equal(revised.value.scope.space, active.spaceId);
  assert.equal(revised.value.pack.id, fictionalPack.id);
  assert.equal(revised.value.sources[0]?.ref, "source:orbit-revision");
  assert.equal(revised.value.session.id, "synthetic-session-a");
});

test("a live lock refuses and an explicitly proven stale lock is recovered", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-lock-recovery");
  const { proposal } = await reconcileWithMiss(active, candidate("new", { id: "lock-candidate" }));
  const lockPath = transactionLockDirectory(active);
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ schema_version: 0, pid: process.pid, hostname: hostname(), token: "live-owner" }),
    "utf8",
  );
  const refused = await applyKnowledgeProposal(
    applyInput(active, proposal, "approve", proposal.plan_hash),
  );
  assert.equal(refused.status, "lock_conflict");

  await rm(lockPath, { recursive: true, force: true });
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ schema_version: 0, pid: 99999999, hostname: hostname(), token: "absent-owner" }),
    "utf8",
  );
  const qmd = makeAlwaysSucceedsSpawnFn("Indexed: 1 new, 0 updated, 0 unchanged, 0 removed");
  const recovered = await applyKnowledgeProposal(
    applyInput(active, proposal, "approve", proposal.plan_hash, { spawnFn: qmd.spawnFn }),
  );
  assert.equal(recovered.status, "committed");
  if (recovered.status !== "committed") return;
  assert.equal(recovered.lock.state, "recovered");
});

test("the transaction lock prevents two approvals from the same stale input from both committing", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-concurrent-approval");
  const { proposal } = await reconcileWithHit(active, candidate("contradict"));
  let unblock: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let writes = 0;
  const writeRecord = async (path: string, content: string): Promise<void> => {
    writes++;
    if (writes === 1) {
      signalStarted?.();
      await gate;
    }
    await atomicWriteFile(path, content);
  };
  const firstQmd = makeAlwaysSucceedsSpawnFn("Indexed: 2 new, 0 updated, 0 unchanged, 0 removed");
  const firstPromise = applyKnowledgeProposal(
    applyInput(active, proposal, "approve", proposal.plan_hash, { writeRecord, spawnFn: firstQmd.spawnFn }),
  );
  await started;
  const secondQmd = makeAlwaysSucceedsSpawnFn("must not run");
  const second = await applyKnowledgeProposal(
    applyInput(active, proposal, "approve", proposal.plan_hash, { spawnFn: secondQmd.spawnFn }),
  );
  assert.equal(second.status, "lock_conflict");
  unblock?.();
  const first = await firstPromise;
  assert.equal(first.status, "committed");
  assert.equal(secondQmd.calls.length, 0);
});

test("qmd failure after commit leaves Markdown authoritative and pre-write or post-rename failures never refresh", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-recovery-semantics");
  const first = await reconcileWithMiss(active, candidate("new", { id: "qmd-fails-after-commit" }));
  const qmdFailure = makeScriptedSpawnFn([{ ranProcess: true, code: 1, stderr: "synthetic qmd failure" }]);
  const committed = await applyKnowledgeProposal(
    applyInput(active, first.proposal, "approve", first.proposal.plan_hash, { spawnFn: qmdFailure.spawnFn }),
  );
  assert.equal(committed.status, "committed");
  if (committed.status !== "committed") return;
  assert.equal(committed.refresh.state, "index-stale");
  assert.equal(committed.refresh.count, 1);
  assert.equal(qmdFailure.calls.length, 1);
  assert.match(await readFile(join(active.recordsRoot, "qmd-fails-after-commit.md"), "utf8"), /qmd-fails-after-commit/);

  const second = await reconcileWithMiss(active, candidate("new", { id: "prewrite-failure" }));
  const prewriteQmd = makeAlwaysSucceedsSpawnFn("must not run");
  const prewrite = await applyKnowledgeProposal(
    applyInput(active, second.proposal, "approve", second.proposal.plan_hash, {
      writeRecord: async () => {
        throw new Error("synthetic pre-write failure");
      },
      spawnFn: prewriteQmd.spawnFn,
    }),
  );
  assert.equal(prewrite.status, "recovery_required");
  assert.equal(prewriteQmd.calls.length, 0);
  assert.equal(await readFile(join(active.recordsRoot, "prewrite-failure.md"), "utf8").catch(() => null), null);

  const third = await reconcileWithMiss(active, candidate("new", { id: "post-rename-ambiguity" }));
  const ambiguityQmd = makeAlwaysSucceedsSpawnFn("must not run");
  const ambiguity = await applyKnowledgeProposal(
    applyInput(active, third.proposal, "approve", third.proposal.plan_hash, {
      writeRecord: async (path, content) => {
        await atomicWriteFile(path, content);
        throw new AtomicWriteDirectorySyncError("synthetic post-rename ambiguity", new Error("directory sync unknown"));
      },
      spawnFn: ambiguityQmd.spawnFn,
    }),
  );
  assert.equal(ambiguity.status, "recovery_required");
  if (ambiguity.status !== "recovery_required") return;
  assert.equal(ambiguity.recovery.required, true);
  assert.ok(ambiguity.recovery.paths.includes(join(active.recordsRoot, "post-rename-ambiguity.md")));
  assert.equal(ambiguityQmd.calls.length, 0);
  assert.match(await readFile(join(active.recordsRoot, "post-rename-ambiguity.md"), "utf8"), /post-rename-ambiguity/);
});

test("no-change writes nothing and does not refresh", async () => {
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-no-change");
  const { proposal } = await reconcileWithHit(active, candidate("no-change"));
  assert.equal(proposal.plan.classification, "no-change");
  const qmd = makeAlwaysSucceedsSpawnFn("must not run");
  const result = await applyKnowledgeProposal(
    applyInput(active, proposal, "approve", proposal.plan_hash, { spawnFn: qmd.spawnFn }),
  );
  assert.equal(result.status, "no_change");
  assert.equal(result.refresh.count, 0);
  assert.equal(qmd.calls.length, 0);
});

test("a second fictional pack uses only the exported envelope and pack boundary", async () => {
  const secondPack: KnowledgePack = {
    id: "second-fictional-pack",
    version: "0.1.0",
    validateEnvelope: (envelope): KnowledgeResult<void> => {
      if (envelope.details.marker !== "second-pack") {
        return { ok: false, errors: [{ kind: "validation", code: "second_pack_details", message: "second pack marker required" }] };
      }
      return { ok: true, value: undefined };
    },
    relatedQuery: (envelope) => envelope.statement,
    reconcile: ({ candidate: submitted }): KnowledgeResult<PackReconciliation> => {
      const record: KnowledgeRecord = {
        schemaVersion: 0,
        ...submitted,
        status: "candidate",
        relationships: { supports: [], contradicts: [], refines: [], supersedes: [] },
        history: [],
      };
      return {
        ok: true,
        value: { disposition: submitted.disposition, summary: "second pack proposal", mutations: [{ action: "create", record }] },
      };
    },
  };
  const { active } = await makeSpace(TRANSACTION_A_RECORDS_DIR, "transaction-second-pack");
  const secondActive: ActiveSpace = {
    ...active,
    packs: [{ id: secondPack.id, version: secondPack.version }],
  };
  const secondCandidate = candidate("new", {
    id: "second-pack-record",
    pack: { id: secondPack.id, version: secondPack.version },
    details: { marker: "second-pack" },
  });
  const result = await reconcileKnowledgeTransaction({
    binding: secondActive,
    candidateInput: secondCandidate,
    pack: secondPack,
    spawnFn: makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "[]" }]).spawnFn,
  });
  assert.equal(result.status, "proposal");
  if (result.status !== "proposal") return;
  assert.equal(result.proposal.plan.mutations[0]?.recordId, "second-pack-record");
  assert.equal(result.proposal.candidate.pack.id, secondPack.id);
});

async function writeCliBinding(space: EphemeralSpace, spaceId: string): Promise<{ registryPath: string; bindingPath: string }> {
  const manifestPath = join(space.root, "space.json");
  const sessionsDir = join(space.root, "sessions");
  const fictionalFrom = join(dirname(fileURLToPath(import.meta.url)), "fictionalPack.ts");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      schema_version: 0,
      space_id: spaceId,
      knowledge_schema_version: "0",
      records_dir: "records",
      required_packs: [{ id: fictionalPack.id, version: fictionalPack.version }],
    }),
    "utf8",
  );
  const bindingPath = join(space.root, "binding.json");
  await writeFile(
    bindingPath,
    JSON.stringify({
      schema_version: 0,
      manifest_path: manifestPath,
      qmd_config_dir: space.binding.qmdConfigDir,
      qmd_cache_home: space.binding.qmdCacheHome,
      qmd_collection_name: space.binding.qmdCollectionName,
      sessions_dir: sessionsDir,
      read_roots: [space.root],
      write_roots: [space.root],
      provider_policy: { allowed_models: ["synthetic-provider/synthetic-model"], credential_env: ["SYNTHETIC_TOKEN"] },
      installed_packs: [{ id: fictionalPack.id, version: fictionalPack.version, from: fictionalFrom }],
    }),
    "utf8",
  );
  return { registryPath: join(space.root, "registry.json"), bindingPath };
}

function runCli(args: string[], registryPath: string, sessionId: string, extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(NODE, [CLI, ...args], {
    cwd: HARNESS_DIR,
    env: { ...process.env, ...extraEnv, ENGRAM_BINDING_REGISTRY: registryPath, ENGRAM_HOST_SESSION_ID: sessionId },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cliJson(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("CLI did not return an object");
  return value as Record<string, unknown>;
}

function cliString(value: Record<string, unknown>, field: string): string {
  const found = value[field];
  assert.equal(typeof found, "string", field);
  if (typeof found !== "string") throw new Error(`${field} was not a string`);
  return found;
}

test("CLI knowledge transaction runs the integrity scenario: reject, approve revised plan, and expose index-stale after qmd failure", async () => {
  const space = await createEphemeralSpace(TRANSACTION_A_RECORDS_DIR, "transaction-cli-integrity");
  spacesToClean.push(space);
  const paths = await writeCliBinding(space, "fictional-space-transaction-a");
  const sessionId = "synthetic-cli-session";
  const registered = runCli(["space", "register", "--binding", paths.bindingPath], paths.registryPath, sessionId);
  assert.equal(registered.status, 0, registered.stderr);
  const selected = runCli(["space", "select", "fictional-space-transaction-a"], paths.registryPath, sessionId);
  assert.equal(selected.status, 0, selected.stderr);

  const candidatePath = join(space.root, "contradiction.json");
  const initialCandidate = candidate("contradict");
  await writeFile(candidatePath, JSON.stringify(initialCandidate), "utf8");
  const preview = runCli(["knowledge", "reconcile", "--candidate", candidatePath], paths.registryPath, sessionId);
  assert.equal(preview.status, 0, preview.stderr);
  const previewJson = cliJson(preview.stdout);
  assert.equal(previewJson.status, "proposal");
  const previewValue = previewJson.proposal;
  assert.equal(typeof previewValue, "object");
  assert.notEqual(previewValue, null);
  if (typeof previewValue !== "object" || previewValue === null || Array.isArray(previewValue)) throw new Error("missing CLI proposal");
  const previewRecord = previewValue as Record<string, unknown>;
  const previewPlanHashValue = previewRecord.plan_hash;
  assert.equal(typeof previewPlanHashValue, "string");
  if (typeof previewPlanHashValue !== "string") throw new Error("missing plan hash");
  const beforeReject = await readFile(join(space.binding.recordsRoot, "orbit-claim.md"));
  const rejected = runCli(["knowledge", "reject", "--candidate", candidatePath, "--expect", previewPlanHashValue], paths.registryPath, sessionId);
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.equal(cliJson(rejected.stdout).status, "rejected");
  assert.deepEqual(await readFile(join(space.binding.recordsRoot, "orbit-claim.md")), beforeReject);

  const revisedCandidate = candidate("contradict", {
    sources: [{ type: "observation", ref: "source:orbit-revision-revised" }],
    submitted_at: "2026-08-06",
  });
  await writeFile(candidatePath, JSON.stringify(revisedCandidate), "utf8");
  const revisedPreview = runCli(["knowledge", "reconcile", "--candidate", candidatePath], paths.registryPath, sessionId);
  assert.equal(revisedPreview.status, 0, revisedPreview.stderr);
  const revisedJson = cliJson(revisedPreview.stdout);
  assert.equal(revisedJson.status, "proposal");
  const revisedProposalValue = revisedJson.proposal;
  assert.equal(typeof revisedProposalValue, "object");
  assert.notEqual(revisedProposalValue, null);
  if (typeof revisedProposalValue !== "object" || revisedProposalValue === null || Array.isArray(revisedProposalValue)) throw new Error("missing revised proposal");
  const revisedPlanHash = cliString(revisedProposalValue as Record<string, unknown>, "plan_hash");
  const approved = runCli(["knowledge", "approve", "--candidate", candidatePath, "--expect", revisedPlanHash], paths.registryPath, sessionId);
  assert.equal(approved.status, 0, approved.stderr);
  const approvedJson = cliJson(approved.stdout);
  assert.equal(approvedJson.status, "committed");
  assert.equal((approvedJson.refresh as Record<string, unknown>).state, "fresh");
  const retained = await readFile(join(space.binding.recordsRoot, "orbit-claim.md"), "utf8");
  assert.match(retained, /status: "contested"/);
  assert.match(await readFile(join(space.binding.recordsRoot, "orbit-revised.md"), "utf8"), /source:orbit-revision-revised/);

  const staleCandidate = candidate("new", { id: "cli-qmd-failure" });
  await writeFile(candidatePath, JSON.stringify(staleCandidate), "utf8");
  const fakeQmdDir = join(space.root, "fake-qmd-bin");
  await mkdir(fakeQmdDir, { recursive: true });
  const fakeQmd = join(fakeQmdDir, "qmd");
  await writeFile(
    fakeQmd,
    "#!/bin/sh\nif [ \"$1\" = \"search\" ]; then printf '%s\\n' '[{\"file\":\"qmd://transaction-cli-integrity/orbit-claim.md\"}]'; else printf '%s\\n' 'synthetic qmd update failure' >&2; exit 9; fi\n",
    "utf8",
  );
  await chmod(fakeQmd, 0o755);
  const fakeQmdEnv = { PATH: `${fakeQmdDir}:${process.env.PATH ?? ""}` };
  const stalePreview = runCli(["knowledge", "reconcile", "--candidate", candidatePath], paths.registryPath, sessionId, fakeQmdEnv);
  assert.equal(stalePreview.status, 0, stalePreview.stderr);
  const stalePreviewJson = cliJson(stalePreview.stdout);
  assert.equal(stalePreviewJson.status, "proposal");
  const staleProposalValue = stalePreviewJson.proposal;
  assert.equal(typeof staleProposalValue, "object");
  assert.notEqual(staleProposalValue, null);
  if (typeof staleProposalValue !== "object" || staleProposalValue === null || Array.isArray(staleProposalValue)) throw new Error("missing stale proposal");
  const stalePlanHash = cliString(staleProposalValue as Record<string, unknown>, "plan_hash");
  const staleCommit = runCli(
    ["knowledge", "approve", "--candidate", candidatePath, "--expect", stalePlanHash],
    paths.registryPath,
    sessionId,
    fakeQmdEnv,
  );
  assert.equal(staleCommit.status, 0, staleCommit.stderr);
  const staleJson = cliJson(staleCommit.stdout);
  assert.equal(staleJson.status, "committed");
  assert.equal((staleJson.refresh as Record<string, unknown>).state, "index-stale");
  assert.match(await readFile(join(space.binding.recordsRoot, "cli-qmd-failure.md"), "utf8"), /cli-qmd-failure/);
});
