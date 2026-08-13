/**
 * Extension test — exercises engramExtension against a fixture space with
 * the external-demo pack, verifying that the engram_capture tool handler
 * resolves the pack via the binding's `from` field and submits the candidate.
 *
 * Runs under `bun test` (not `node --test`) because the extension uses
 * Bun.spawn. The file name avoids Node's test discovery globs (`*.check.ts`
 * instead of `*.test.ts` or `*-test.ts`). Invoke with:
 *   cd harness && bun test ./omp/ompExtension.check.ts
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import engramExtension, {
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "./omp-extension.ts";
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
  let agentEndHandler: ((event: AgentEndEvent, ctx: ExtensionContext) => void | Promise<void>) | undefined;
  let toolHandler: ((params: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
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
        agentEndHandler = handler;
      },
      registerTool: (tool) => {
        toolHandler = tool.handler;
      },
      logger: { info: (_msg) => {}, warn: (message) => { warnings.push(message); } },
    };

    await engramExtension(mockApi);

    assert.ok(agentEndHandler !== undefined, "agent_end handler was not registered");
    assert.ok(toolHandler !== undefined, "engram_capture tool handler was not registered");

    // Fire agent_end first to populate hostSessionId and resolve the
    // extraction pack. This makes the tool handler's subsequent CLI
    // spawn use the correct session and pack id.
    await agentEndHandler(
      {
        type: "agent_end",
        messages: [{ role: "assistant", content: "nothing noteworthy" }],
        willContinue: false,
        sessionId,
        turnIndex: 0,
        timestamp: new Date().toISOString(),
      },
      { sessionId, cwd: space.root },
    );

    assert.equal(
      warnings.some((warning) => warning.includes("capture-from-turn")),
      false,
      `agent_end capture failed: ${warnings.join("\n")}`,
    );

    // Now invoke the tool handler — it should use the resolved session
    // and external-demo pack, spawning the CLI with correct args.
    const result = await toolHandler({
      kind: "claim",
      statement: "External pack resolves via from from extension tool.",
      topics: ["topic:external"],
    });

    assert.equal(result.status, "submitted", `expected submitted, got ${JSON.stringify(result)}`);
  } finally {
    process.env.ENGRAM_BINDING_REGISTRY = envBackup.ENGRAM_BINDING_REGISTRY;
    process.env.ENGRAM_HOST_SESSION_ID = envBackup.ENGRAM_HOST_SESSION_ID;
    process.env.ENGRAM_CLI = envBackup.ENGRAM_CLI;
  }
});
