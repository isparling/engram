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
  type OmpSpawn,
  type ToolDefinition,
} from "./omp-extension.ts";
import { registerSpace } from "../src/spaceRegistry.ts";
import {
  captureInvocations,
  completionErrors,
  completionOutcomes,
  completionRequests,
  materializeInvocations,
  resetCaptureFixtures,
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

/** One observed child-OMP spawn. */
type SpawnRecord = { argv: string[]; signal: AbortSignal };

/**
 * How the injected seam should behave. `hang` never exits on its own, so the
 * only way the promise settles is an abort — which is exactly what the
 * cancellation and deadline tests need to observe.
 */
type SpawnBehavior = {
  hang?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  onSpawn?: (record: SpawnRecord) => void;
};

type Harness = {
  space: EphemeralSpace;
  spaceId: string;
  sessionId: string;
  tools: Map<string, ToolDefinition>;
  warnings: string[];
  envBackup: Record<string, string | undefined>;
  spawns: SpawnRecord[];
  behavior: SpawnBehavior;
  fireSessionStop(sessionId: string): Promise<void>;
  fireSessionStopWith(
    sessionId: string,
    messages: unknown[],
    controller?: AbortController,
  ): Promise<void>;
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

  const spawns: SpawnRecord[] = [];
  const behavior: SpawnBehavior = {};
  const spawnOmp: OmpSpawn = (argv, spawnOptions) => {
    const record: SpawnRecord = { argv, signal: spawnOptions.signal };
    spawns.push(record);
    behavior.onSpawn?.(record);
    const exited = behavior.hang === true
      ? new Promise<number>((resolveExit) => {
          if (spawnOptions.signal.aborted) resolveExit(143);
          else spawnOptions.signal.addEventListener("abort", () => resolveExit(143), { once: true });
        })
      : Promise.resolve(behavior.exitCode ?? 0);
    return {
      exited,
      stdout: new Response(behavior.stdout ?? "").body!,
      stderr: new Response(behavior.stderr ?? "").body!,
    };
  };

  await engramExtension(mockApi, { spawnOmp });
  assert.ok(sessionStopHandler !== undefined, "session_stop handler was not registered");

  async function fireSessionStopWith(
    stopSessionId: string,
    messages: unknown[],
    controller: AbortController = new AbortController(),
  ): Promise<void> {
    process.env.ENGRAM_HOST_SESSION_ID = stopSessionId;
    await sessionStopHandler!(
      {
        type: "session_stop",
        messages,
        session_id: stopSessionId,
        session_file: join(sessionsDir, `2026-08-22T12-00-00-000Z_${stopSessionId}.jsonl`),
        turn_id: 0,
        stop_hook_active: false,
        signal: controller.signal,
      },
      { cwd: space.root },
    );
  }

  async function fireSessionStop(stopSessionId: string): Promise<void> {
    await fireSessionStopWith(stopSessionId, [
      { role: "user", id: "settle-user", content: "settle observation" },
    ]);
  }
  await fireSessionStop(sessionId);
  assert.equal(
    warnings.some((warning) => warning.includes("could not resolve")),
    false,
    `session resolution failed: ${warnings.join("\n")}`,
  );

  return {
    space,
    spaceId,
    sessionId,
    tools,
    warnings,
    envBackup,
    spawns,
    behavior,
    fireSessionStop,
    fireSessionStopWith,
  };
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

// ---------------------------------------------------------------------------
// Ambient capture: isolated child-OMP completion and latest-user-turn context
// ---------------------------------------------------------------------------

test("headless completion spawns an isolated child OMP with the exact argv", async () => {
  resetCaptureFixtures();
  const harness = await startHarness("omp-complete-argv", "session-complete-argv");
  try {
    harness.behavior.stdout = "synthetic completion output";
    await harness.fireSessionStopWith("session-complete-argv", [
      { role: "user", id: "u1", content: "run-completion please" },
    ]);

    assert.equal(harness.spawns.length, 1, "expected exactly one child OMP spawn");
    const spawn = harness.spawns[0];
    assert.ok(spawn !== undefined, "child OMP was never spawned");
    assert.deepEqual(spawn.argv, [
      "omp",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--mode",
      "text",
      "--model",
      "synthetic/provider-model",
      "-p",
      "synthetic extraction prompt",
    ]);
    assert.deepEqual(completionOutcomes, ["synthetic completion output"]);
    assert.deepEqual(completionErrors, []);

    const invocation = captureInvocations.at(-1);
    assert.ok(invocation !== undefined, "the pack capture handler never ran");
    assert.equal(invocation.hasComplete, true, "tools.complete was not supplied");
    assert.equal(invocation.projectRoot, process.env.ENGRAM_PROJECT_ROOT);
  } finally {
    await closeHarness(harness);
  }
});

test("a nonzero completion exit rejects with stderr as capture_model_failed", async () => {
  resetCaptureFixtures();
  const harness = await startHarness("omp-complete-fail", "session-complete-fail");
  try {
    harness.behavior.exitCode = 3;
    harness.behavior.stderr = "synthetic provider rejected the request";
    await harness.fireSessionStopWith("session-complete-fail", [
      { role: "user", id: "u1", content: "run-completion please" },
    ]);

    assert.equal(completionErrors.length, 1);
    const failure = completionErrors[0] ?? "";
    assert.match(failure, /capture_model_failed/);
    assert.match(failure, /exited 3/);
    assert.match(failure, /synthetic provider rejected the request/);
    assert.deepEqual(completionOutcomes, []);
    // No deterministic fallback: the failure surfaces as a logged warning.
    assert.ok(
      harness.warnings.some((warning) => warning.includes("capture warning: ")
        && warning.includes("capture_model_failed")),
      `expected a visible capture warning, got: ${harness.warnings.join("\n")}`,
    );
  } finally {
    await closeHarness(harness);
  }
});

test("a 60-second request arms a bounded deadline that reports capture_timeout", async () => {
  resetCaptureFixtures();
  const harness = await startHarness("omp-complete-timeout", "session-complete-timeout");
  try {
    // The child never exits on its own; only the request's own deadline can
    // end it, which is what proves the timer is armed and bounded.
    harness.behavior.hang = true;
    await harness.fireSessionStopWith("session-complete-timeout", [
      { role: "user", id: "u1", content: "run-completion fast-deadline" },
    ]);

    assert.equal(completionRequests.length, 1);
    assert.equal(completionRequests[0]?.timeoutSeconds, 0.05);
    assert.equal(completionErrors.length, 1);
    assert.match(completionErrors[0] ?? "", /capture_timeout/);
    assert.deepEqual(completionOutcomes, []);

    const spawn = harness.spawns[0];
    assert.ok(spawn !== undefined, "child OMP was never spawned");
    assert.equal(spawn.signal.aborted, true, "the deadline never aborted the child");
  } finally {
    await closeHarness(harness);
  }
});

test("the stop-hook abort signal reaches the child and reports capture_cancelled", async () => {
  resetCaptureFixtures();
  const harness = await startHarness("omp-complete-cancel", "session-complete-cancel");
  try {
    const controller = new AbortController();
    harness.behavior.hang = true;
    // Abort the stop hook once the child is running: the combined signal must
    // carry that cancellation into the spawned process.
    harness.behavior.onSpawn = () => { controller.abort(); };

    await harness.fireSessionStopWith(
      "session-complete-cancel",
      [{ role: "user", id: "u1", content: "run-completion please" }],
      controller,
    );

    const spawn = harness.spawns[0];
    assert.ok(spawn !== undefined, "child OMP was never spawned");
    assert.equal(spawn.signal.aborted, true, "the stop-hook abort never reached the child");
    assert.equal(completionErrors.length, 1);
    assert.match(completionErrors[0] ?? "", /capture_cancelled/);
    assert.deepEqual(completionOutcomes, []);
  } finally {
    await closeHarness(harness);
  }
});

test("the turn narrative holds only the latest user message while tool provenance survives", async () => {
  resetCaptureFixtures();
  const harness = await startHarness("omp-latest-turn", "session-latest-turn");
  try {
    const messages = [
      { role: "user", id: "u1", content: "first user question" },
      { role: "assistant", id: "a1", content: "first assistant answer" },
      { role: "user", id: "u2", content: "second user question" },
      {
        role: "assistant",
        id: "a2",
        content: "applying the approved plan",
        tool_calls: [{ name: "engram_capture_apply", input: { plan_hash: "hash-abc" } }],
      },
      {
        role: "tool",
        id: "t1",
        name: "engram_capture_apply",
        content: '{"status":"committed","entity_keys":["demo:key-1"]}',
      },
    ];
    await harness.fireSessionStopWith("session-latest-turn", messages);

    const invocation = captureInvocations.at(-1);
    assert.ok(invocation !== undefined, "the pack capture handler never ran");
    assert.equal(invocation.narrative, "second user question");
    assert.ok(!invocation.narrative.includes("first user question"));
    assert.ok(!invocation.narrative.includes("first assistant answer"));
    // turnIndex is the stable index of that user message, not the message
    // count, so repeat settlement yields the same ambient record IDs.
    assert.equal(invocation.turnIndex, 2);

    const applyCall = invocation.toolCalls.find((call) => call.tool === "engram_capture_apply");
    assert.ok(applyCall !== undefined, "the explicit apply call was dropped from tool provenance");
    assert.deepEqual(applyCall.input, { plan_hash: "hash-abc" });
    assert.equal(applyCall.result, '{"status":"committed","entity_keys":["demo:key-1"]}');
  } finally {
    await closeHarness(harness);
  }
});
