/**
 * Extension test — verifies hash-bound structured capture through the two
 * typed tools (`engram_capture_preview`, `engram_capture_apply`) plus the
 * extended `engram_status` surface and final-settle delegation to the
 * binding-selected pack's captureFromTurn handler.
 * Runs under `bun test` (not `node --test`) because the extension uses
 * Bun.spawn. The file name avoids Node's test discovery globs (`*.check.ts`
 * instead of `*.test.ts` or `*-test.ts`). Invoke with:
 *   cd harness && bun test ./omp/ompExtension.check.ts
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import engramExtension, {
  type SessionStopEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "./omp-extension.ts";
import { registerSpace } from "../src/spaceRegistry.ts";
import {
  captureInvocations,
  materializeInvocations,
  stageMaterializeFailure,
} from "../test/packLoader.fixture.ts";
import {
  createUninitializedEphemeralSpace,
  destroyEphemeralSpace,
  type EphemeralSpace,
} from "../test/testSupport.ts";

const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPACE_A_RECORDS_DIR = join(HARNESS_ROOT, "test-fixtures", "space-a", "records");
const CLI_PATH = join(HARNESS_ROOT, "src", "cli.ts");
const FIXTURE_PATH = join(HARNESS_ROOT, "test", "packLoader.fixture.ts");

const ENV_KEYS = ["ENGRAM_BINDING_REGISTRY", "ENGRAM_HOST_SESSION_ID", "ENGRAM_CLI", "ENGRAM_PROJECT_ROOT"] as const;
const spacesToClean: EphemeralSpace[] = [];

after(async () => {
  for (const space of spacesToClean) await destroyEphemeralSpace(space);
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = {
  space: EphemeralSpace;
  spaceId: string;
  sessionId: string;
  tools: Map<string, ToolDefinition>;
  warnings: string[];
  envBackup: Record<string, string | undefined>;
  fireSessionStop(sessionId: string): Promise<void>;
};

async function closeHarness(harness: Harness): Promise<void> {
  for (const key of ENV_KEYS) {
    const value = harness.envBackup[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function callJsonTool(
  harness: Harness,
  name: string,
  params: Record<string, unknown>,
): Promise<Record<string, any>> {
  const tool = harness.tools.get(name);
  assert.ok(tool !== undefined, `${name} was not registered`);
  const result = await tool.execute(params);
  return JSON.parse(result.content[0]?.text ?? "{}");
}

async function startHarness(spaceId: string, sessionId: string): Promise<Harness> {
  // An empty records root: the generic space-a fixtures are not valid
  // knowledge records and would fail authoritative retrieval.
  const emptyRecordsDir = await mkdtemp(join(tmpdir(), "engram-omp-records-"));
  const space = await createUninitializedEphemeralSpace(emptyRecordsDir, spaceId);
  spacesToClean.push(space);
  const manifestPath = join(space.root, "engram.space.json");
  const sessionsDir = join(space.root, "sessions");
  const registryPath = join(space.root, "registry.json");
  const bindingPath = join(space.root, "binding.json");
  await mkdir(sessionsDir, { recursive: true });

  await writeFile(
    manifestPath,
    JSON.stringify({
      schema_version: 0,
      space_id: spaceId,
      knowledge_schema_version: "0",
      records_dir: "records",
      required_packs: [{ id: "external-demo", version: "0.1.0" }],
    }),
    "utf8",
  );
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
      provider_policy: {
        allowed_models: ["fictional-provider/fictional-model"],
        credential_env: ["FICTIONAL_PROVIDER_TOKEN"],
      },
      installed_packs: [
        { id: "external-demo", version: "0.1.0", from: FIXTURE_PATH, extract: true },
      ],
    }),
    "utf8",
  );
  const registered = await registerSpace(registryPath, bindingPath);
  if (!registered.ok) {
    assert.fail(`space registration failed: ${JSON.stringify(registered.errors)}`);
  }

  // A .ts file is not directly spawnable (EACCES); install an executable
  // wrapper that runs the CLI through bun.
  const wrapperPath = join(space.root, "engram-cli-wrapper");
  await writeFile(wrapperPath, `#!/bin/sh\nexec ${process.execPath} ${CLI_PATH} "$@"\n`, { mode: 0o755 });

  const envBackup: Record<string, string | undefined> = { ...process.env };
  process.env.ENGRAM_BINDING_REGISTRY = registryPath;
  process.env.ENGRAM_HOST_SESSION_ID = sessionId;
  process.env.ENGRAM_CLI = wrapperPath;
  process.env.ENGRAM_PROJECT_ROOT = join(space.root, "generated-root");
  await mkdir(process.env.ENGRAM_PROJECT_ROOT, { recursive: true });
  delete process.env.ENGRAM_SPACE_ID;

  const tools = new Map<string, ToolDefinition>();
  let sessionStopHandler:
    | ((event: SessionStopEvent, ctx: ExtensionContext) => void | Promise<void>)
    | undefined;
  const warnings: string[] = [];
  const mockApi: ExtensionAPI = {
    on: (_event, handler) => {
      sessionStopHandler = handler;
    },
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
    logger: { info: (_msg) => {}, warn: (message) => { warnings.push(message); } },
  };

  await engramExtension(mockApi);
  assert.ok(sessionStopHandler !== undefined, "session_stop handler was not registered");

  async function fireSessionStop(stopSessionId: string): Promise<void> {
    process.env.ENGRAM_HOST_SESSION_ID = stopSessionId;
    await sessionStopHandler!(
      {
        type: "session_stop",
        messages: [{ role: "user", id: "settle-user", content: "settle observation" }],
        session_id: stopSessionId,
        session_file: join(sessionsDir, `2026-08-22T12-00-00-000Z_${stopSessionId}.jsonl`),
        turn_id: 0,
        stop_hook_active: false,
        signal: new AbortController().signal,
      },
      { cwd: space.root },
    );
  }
  await fireSessionStop(sessionId);
  assert.equal(
    warnings.some((warning) => warning.includes("could not resolve")),
    false,
    `session resolution failed: ${warnings.join("\n")}`,
  );

  return { space, spaceId, sessionId, tools, warnings, envBackup, fireSessionStop };
}

/** Run the wrapped CLI and return parsed stdout plus the exit code. */
async function runSeedCli(
  args: string[],
): Promise<{ exitCode: number; json: Record<string, any> }> {
  const proc = Bun.spawn([process.env.ENGRAM_CLI!, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  const exitCode = await proc.exited;
  const raw = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(raw);
  } catch {
    assert.fail(`seed CLI ${args.join(" ")} printed no JSON (exit ${exitCode}): ${(raw || stderr).slice(0, 500)}`);
  }
  return { exitCode, json };
}

async function seedRecord(harness: Harness): Promise<void> {
  const candidatePath = join(harness.space.root, "seed-candidate.json");
  await writeFile(
    candidatePath,
    JSON.stringify({
      id: "seed-candidate",
      kind: "claim",
      status: "candidate",
      disposition: "new",
      scope: {
        space: harness.spaceId,
        subjects: [],
        topics: ["test:seed"],
        contexts: [],
        dimensions: {},
      },
      pack: { id: "external-demo", version: "0.1.0" },
      sources: [{ type: "engram-capture-tool", ref: "structured-change-set" }],
      session: { id: harness.sessionId, host: "omp" },
      submitted_at: "2026-08-22",
      details: {
        fixture_action: "create",
        fixture_record_id: "seed-record",
        fixture_target: "seed-record",
        entityKey: "project-status",
      },
      statement: "seed record",
    }),
    "utf8",
  );
  const reconciled = await runSeedCli(["knowledge", "reconcile", "--candidate", candidatePath]);
  assert.equal(reconciled.exitCode, 0, `seed reconcile failed: ${JSON.stringify(reconciled.json).slice(0, 500)}`);
  const planHash = reconciled.json.proposal?.plan_hash;
  assert.equal(typeof planHash, "string", "seed reconcile produced no plan_hash");
  const approved = await runSeedCli(["knowledge", "approve", "--candidate", candidatePath, "--expect", planHash]);
  assert.equal(
    approved.exitCode,
    0,
    `seed approve failed (exit ${approved.exitCode}): ${JSON.stringify(approved.json).slice(0, 500)}`,
  );
}

function changeSetFor(harness: Harness, note: string): Record<string, unknown> {
  return {
    target: "seed-record",
    note,
    space: harness.spaceId,
    session_id: harness.sessionId,
  };
}
async function previewPlan(harness: Harness, note: string): Promise<Record<string, any>> {
  return callJsonTool(harness, "engram_capture_preview", { change_set: changeSetFor(harness, note) });
}

/** Mutate the seeded record on disk behind the transaction's back. */
async function mutateSeedRecordOnDisk(harness: Harness): Promise<void> {
  const recordsRoot = await realpath(harness.space.binding.recordsRoot);
  const entries = await readdir(recordsRoot);
  const match = entries.find((entry) => entry.startsWith("seed-record"));
  assert.ok(match !== undefined, `seed-record file not found in ${entries.join(", ")}`);
  const path = join(recordsRoot, match);
  const text = await readFile(path, "utf8");
  assert.ok(text.includes("seed record"), "seed record shape unexpected");
  // Mutate statement (frontmatter and matching body) in place: the file stays
  // a valid knowledge record but its bytes — and therefore the plan hash —
  // no longer match the preview.
  await writeFile(path, text.replaceAll("seed record", "mutated underneath"), "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("preview returns mutation summary without exposing the candidate; apply commits the same hash", async () => {
  const harness = await startHarness("omp-cap-happy", "omp-cap-happy-session");
  try {
    await seedRecord(harness);
    materializeInvocations.length = 0;

    const preview = await previewPlan(harness, "first structured note");
    assert.equal(typeof preview.plan_hash, "string");
    assert.ok((preview.plan_hash ?? "").length > 0);
    assert.deepEqual(preview.changes, [{ recordId: "seed-record", action: "update" }]);
    assert.deepEqual(preview.artifacts, ["generated/status-view.yaml"]);
    assert.equal(preview.status, undefined);

    const rawPreviewText = JSON.stringify(preview);
    assert.equal(rawPreviewText.includes("candidate"), false);
    assert.equal(rawPreviewText.includes("submitted_at"), false);
    assert.equal(rawPreviewText.includes('"statement"'), false);

    const statusDuringPending = await callJsonTool(harness, "engram_status", {});
    assert.deepEqual(statusDuringPending.pending_plan_hashes, [preview.plan_hash]);
    assert.equal(statusDuringPending.pack_id, "external-demo");
    assert.equal(statusDuringPending.pack_version, "0.1.0");
    assert.equal(statusDuringPending.mode, "cli");

    const applied = await callJsonTool(harness, "engram_capture_apply", { plan_hash: preview.plan_hash });
    assert.equal(applied.status, "committed");
    assert.equal(applied.plan_hash, preview.plan_hash);
    assert.deepEqual(applied.created, []);
    assert.deepEqual(applied.retired, []);
    assert.deepEqual(applied.entity_keys, ["project-status"]);
    assert.deepEqual(
      applied.artifacts.generated,
      [join(process.env.ENGRAM_PROJECT_ROOT!, "generated", "status-view.yaml")],
    );
    assert.ok(applied.index === "fresh" || applied.index === "stale");

    // Materialization ran once through the host mechanics and wrote its artifact.
    assert.equal(materializeInvocations.length, 1);
    const firstMaterialization = materializeInvocations[0];
    assert.ok(firstMaterialization !== undefined, "materializer did not run");
    assert.equal(firstMaterialization.planHash, preview.plan_hash);
    const artifactText = await readFile(
      join(harness.space.root, "generated-root", "generated", "status-view.yaml"),
      "utf8",
    ).catch(() => undefined);
    assert.ok(artifactText !== undefined, "materializer did not write its artifact");

    const statusAfterApply = await callJsonTool(harness, "engram_status", {});
    assert.deepEqual(statusAfterApply.pending_plan_hashes, []);
    assert.ok(captureInvocations.length >= 1, "ambient settle path did not delegate to the pack handler");
  } finally {
    stageMaterializeFailure(0);
    await closeHarness(harness);
  }
});

test("apply after an underlying record mutation is refused as stale; fresh preview recovers", async () => {
  const harness = await startHarness("omp-cap-stale", "omp-cap-stale-session");
  try {
    await seedRecord(harness);

    const stalePreview = await previewPlan(harness, "stale-bound note");
    await mutateSeedRecordOnDisk(harness);

    const refused = await callJsonTool(harness, "engram_capture_apply", { plan_hash: stalePreview.plan_hash });
    assert.equal(refused.status, "stale");
    assert.equal(refused.plan_hash, stalePreview.plan_hash);

    // The stale pending entry was deleted; nothing is pending again until a
    // fresh preview succeeds.
    let status = await callJsonTool(harness, "engram_status", {});
    assert.deepEqual(status.pending_plan_hashes, []);

    const freshPreview = await previewPlan(harness, "fresh note after mutation");
    assert.notEqual(freshPreview.plan_hash, stalePreview.plan_hash);
    status = await callJsonTool(harness, "engram_status", {});
    assert.deepEqual(status.pending_plan_hashes, [freshPreview.plan_hash]);

    const applied = await callJsonTool(harness, "engram_capture_apply", { plan_hash: freshPreview.plan_hash });
    assert.equal(applied.status, "committed");
  } finally {
    stageMaterializeFailure(0);
    await closeHarness(harness);
  }
});

test("materializer failure retains the plan; retrying the same hash reruns only materialization", async () => {
  const harness = await startHarness("omp-cap-retry", "omp-cap-retry-session");
  try {
    await seedRecord(harness);
    materializeInvocations.length = 0;

    const preview = await previewPlan(harness, "retry-bound note");
    const planHash = preview.plan_hash as string;

    stageMaterializeFailure(1);
    const firstApply = await callJsonTool(harness, "engram_capture_apply", { plan_hash: planHash });
    assert.equal(firstApply.status, "records-committed");
    assert.ok(Array.isArray(firstApply.artifacts.stale) && firstApply.artifacts.stale.length > 0);
    assert.equal(materializeInvocations.length, 1);

    // The underlying record changes after commit; a second apply must NOT
    // rerun knowledge approve (which would now be stale) — only materialize.
    await mutateSeedRecordOnDisk(harness);

    const secondApply = await callJsonTool(harness, "engram_capture_apply", { plan_hash: planHash });
    assert.equal(secondApply.status, "committed", `expected clean retry, got ${JSON.stringify(secondApply)}`);
    assert.equal(secondApply.plan_hash, planHash);
    assert.equal(materializeInvocations.length, 2);
    const retryMaterialization = materializeInvocations[1];
    assert.ok(retryMaterialization !== undefined, "retry did not materialize");
    assert.equal(retryMaterialization.planHash, planHash);

    const status = await callJsonTool(harness, "engram_status", {});
    assert.deepEqual(status.pending_plan_hashes, []);
  } finally {
    stageMaterializeFailure(0);
    await closeHarness(harness);
  }
});

test("unknown and session-mismatched plan hashes are rejected without invoking the CLI", async () => {
  const harness = await startHarness("omp-cap-unknown", "omp-cap-unknown-session");
  try {
    await seedRecord(harness);

    const unknown = await callJsonTool(harness, "engram_capture_apply", { plan_hash: "does-not-exist" });
    assert.equal(unknown.status, "error");
    assert.match(JSON.stringify(unknown.errors), /unknown or session-mismatched/);

    const preview = await previewPlan(harness, "session-bound note");

    // A different host session clears pending plans and invalidates the hash.
    await harness.fireSessionStop("omp-cap-unknown-other-session");
    const mismatched = await callJsonTool(harness, "engram_capture_apply", { plan_hash: preview.plan_hash });
    assert.equal(mismatched.status, "error");
    assert.match(JSON.stringify(mismatched.errors), /unknown or session-mismatched/);

    const status = await callJsonTool(harness, "engram_status", {});
    assert.deepEqual(status.pending_plan_hashes, []);
  } finally {
    stageMaterializeFailure(0);
    await closeHarness(harness);
  }
});
