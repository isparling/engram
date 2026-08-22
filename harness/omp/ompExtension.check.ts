/**
 * Extension test — verifies final-settle delegation to the binding-selected
 * pack's optional captureFromTurn handler and preserves engram_capture tool
 * submission through the CLI fallback surface.
 * Runs under `bun test` (not `node --test`) because the extension uses
 * Bun.spawn. The file name avoids Node's test discovery globs (`*.check.ts`
 * instead of `*.test.ts` or `*-test.ts`). Invoke with:
 *   cd harness && bun test ./omp/ompExtension.check.ts
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import engramExtension, {
  type SessionStopEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "./omp-extension.ts";
import { captureInvocations } from "../test/packLoader.fixture.ts";
import { registerSpace, selectSpace } from "../src/spaceRegistry.ts";
import {
  createUninitializedEphemeralSpace,
  destroyEphemeralSpace,
  type EphemeralSpace,
} from "../test/testSupport.ts";

const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPACE_A_RECORDS_DIR = join(HARNESS_ROOT, "test-fixtures", "space-a", "records");
const CLI_PATH = join(HARNESS_ROOT, "src", "cli.ts");
const FIXTURE_PATH = join(HARNESS_ROOT, "test", "packLoader.fixture.ts");

const spacesToClean: EphemeralSpace[] = [];

after(async () => {
  for (const space of spacesToClean) await destroyEphemeralSpace(space);
});

declare const compileOnlyApi: ExtensionAPI;
function assertLegacyInMemoryPackIsNotPublicApi(): void {
  // @ts-expect-error The extension must accept only the OMP API; binding-owned
  // external resolution is its sole pack-routing input.
  void engramExtension(compileOnlyApi, { pack: { id: "synthetic", version: "0" } });
}
void assertLegacyInMemoryPackIsNotPublicApi;

test("ompExtension property: engram_capture tool resolves external pack via from rather than pack_unknown", async () => {
  captureInvocations.length = 0;
  // Create a fixture space with the external-demo pack
  const space = await createUninitializedEphemeralSpace(SPACE_A_RECORDS_DIR, "omp-ext-from");
  spacesToClean.push(space);
  const spaceId = "omp-ext-from";
  const sessionId = "omp-ext-from-session";

  const manifestPath = join(space.root, "space.json");
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
  const selected = await selectSpace(registryPath, spaceId, sessionId);
  if (!selected.ok) {
    assert.fail(`space selection failed: ${JSON.stringify(selected.errors)}`);
  }
  let sessionStopHandler: ((event: SessionStopEvent, ctx: ExtensionContext) => void | Promise<void>) | undefined;
  let toolHandler: ToolDefinition["execute"] | undefined;
  const warnings: string[] = [];

  // The extension spawns [cliPath, "knowledge", "submit", ...]. A .ts file
  // isn't directly spawnable (EACCES), so create an executable wrapper that
  // runs the CLI via bun.
  const wrapperDir = space.root;
  const wrapperPath = join(wrapperDir, "engram-cli-wrapper");
  await writeFile(
    wrapperPath,
    `#!/bin/sh\nexec ${process.execPath} ${CLI_PATH} "$@"\n`,
    { mode: 0o755 },
  );

  // Set env vars before calling the extension factory
  const envBackup = { ...process.env };
  process.env.ENGRAM_BINDING_REGISTRY = registryPath;
  process.env.ENGRAM_HOST_SESSION_ID = sessionId;
  process.env.ENGRAM_CLI = wrapperPath;

  try {
    const mockApi: ExtensionAPI = {
      on: (_event, handler) => {
        sessionStopHandler = handler;
      },
      registerTool: (tool) => {
        toolHandler = tool.execute;
      },
      logger: { info: (_msg) => {}, warn: (message) => { warnings.push(message); } },
    };

    await engramExtension(mockApi);

    assert.ok(sessionStopHandler !== undefined, "session_stop handler was not registered");
    assert.ok(toolHandler !== undefined, "engram_capture tool handler was not registered");

    // session_stop carries the persisted session identity and the accumulated
    // transcript. Only the latest user turn is eligible for capture.
    const sessionFile = join(sessionsDir, `2026-08-22T12-00-00-000Z_${sessionId}.jsonl`);
    await sessionStopHandler(
      {
        type: "session_stop",
        messages: [
          { role: "user", id: "old-user", content: "old observation" },
          { role: "assistant", content: "old response" },
          { role: "user", id: "current-user", content: "current observation" },
          { role: "assistant", content: "current response" },
        ],
        session_id: sessionId,
        session_file: sessionFile,
        turn_id: 0,
        stop_hook_active: false,
        signal: new AbortController().signal,
      },
      { cwd: space.root },
    );

    assert.equal(
      warnings.some((warning) => warning.includes("capture-from-turn")),
      false,
      `session_stop capture failed: ${warnings.join("\n")}`,
    );
    const canonicalRecordsRoot = await realpath(space.binding.recordsRoot);
    assert.deepEqual(captureInvocations, [{
      sessionId,
      narrative: "User: current observation\nAssistant: current response",
      spaceId,
      recordsRoot: canonicalRecordsRoot,
      hasWriteFile: true,
      hasRefreshIndex: true,
    }]);
    await sessionStopHandler(
      {
        type: "session_stop",
        messages: [{ role: "user", id: "current-user", content: "current observation" }],
        session_id: sessionId,
        session_file: sessionFile,
        turn_id: 0,
        stop_hook_active: true,
        signal: new AbortController().signal,
      },
      { cwd: space.root },
    );
    const aborted = new AbortController();
    aborted.abort();
    await sessionStopHandler(
      {
        type: "session_stop",
        messages: [{ role: "user", id: "aborted-user", content: "aborted observation" }],
        session_id: sessionId,
        session_file: sessionFile,
        turn_id: 0,
        stop_hook_active: false,
        signal: aborted.signal,
      },
      { cwd: space.root },
    );
    assert.equal(captureInvocations.length, 1, "continued or aborted stops must not capture");
    const continuedFirst = {
      type: "session_stop" as const,
      messages: [{ role: "user", id: "next-user", content: "continued-first observation" }],
      session_id: sessionId,
      session_file: sessionFile,
      turn_id: 0,
      stop_hook_active: true,
      signal: new AbortController().signal,
    };
    await sessionStopHandler(continuedFirst, { cwd: space.root });
    assert.equal(captureInvocations.length, 2, "first observed continuation pass must capture");
    await sessionStopHandler(
      { ...continuedFirst, stop_hook_active: false },
      { cwd: space.root },
    );
    assert.equal(captureInvocations.length, 2, "the same turn must capture only once");

    const outsideRecords = join(space.root, "outside-records");
    await mkdir(outsideRecords);
    await symlink(outsideRecords, join(space.binding.recordsRoot, "linked"), "dir");
    await sessionStopHandler(
      {
        type: "session_stop",
        messages: [{ role: "user", id: "linked-user", content: "linked-write" }],
        session_id: sessionId,
        session_file: sessionFile,
        turn_id: 0,
        stop_hook_active: false,
        signal: new AbortController().signal,
      },
      { cwd: space.root },
    );
    assert.equal(captureInvocations.length, 3);
    assert.equal(
      warnings.some((warning) => warning.includes("escaped records root through a symlink")),
      true,
      `expected symlink refusal: ${warnings.join("\n")}`,
    );
    assert.equal(
      warnings.some((warning) => warning.includes("capture-from-turn")),
      false,
      "pack handler failure must not fall back to CLI capture",
    );

    // Now invoke the tool handler — it should use the resolved session
    // and external-demo pack, spawning the CLI with correct args.
    const result = await toolHandler({
      kind: "claim",
      statement: "External pack resolves via from from extension tool.",
      topics: ["topic:external"],
    });

    assert.ok(result.content[0], "engram_capture returned no text content");
    const payload = JSON.parse(result.content[0].text) as { status: string };
    assert.equal(payload.status, "submitted", `expected submitted, got ${JSON.stringify(result)}`);
  } finally {
    process.env.ENGRAM_BINDING_REGISTRY = envBackup.ENGRAM_BINDING_REGISTRY;
    process.env.ENGRAM_HOST_SESSION_ID = envBackup.ENGRAM_HOST_SESSION_ID;
    process.env.ENGRAM_CLI = envBackup.ENGRAM_CLI;
  }
});
