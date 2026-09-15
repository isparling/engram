import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import engramExtension, {
  type ExtensionAPI,
  type ExtensionContext,
  type SessionStopEvent,
} from "./omp-extension.ts";

const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_SCOPE = join(HARNESS_ROOT, "node_modules", "@engram-portability-test");
const PACKAGE_ROOT = join(PACKAGE_SCOPE, "external-demo");
const root = await mkdtemp(join(tmpdir(), "engram-omp-no-node-"));
const recordsRoot = join(root, "records");
const registryPath = join(root, "registry.json");
const cliPath = join(root, "engram-cli");
const sessionId = "no-node-session";
const environmentKeys = ["ENGRAM_BINDING_REGISTRY", "ENGRAM_CLI", "ENGRAM_PROJECT_ROOT"] as const;
const environmentBackup = new Map(environmentKeys.map((key) => [key, process.env[key]]));

try {
  assert.equal(Bun.which("node"), null, "fixture PATH unexpectedly contains Node");
  assert.notEqual(Bun.which("bun"), null, "fixture PATH must contain Bun");

  await mkdir(recordsRoot, { recursive: true });
  await mkdir(PACKAGE_ROOT, { recursive: true });
  await writeFile(registryPath, JSON.stringify({ schema_version: 0, spaces: [] }), "utf8");
  await writeFile(
    join(PACKAGE_ROOT, "package.json"),
    JSON.stringify({
      name: "@engram-portability-test/external-demo",
      version: "0.1.0",
      type: "module",
      exports: { ".": { import: "./index.ts" } },
    }),
    "utf8",
  );
  await writeFile(
    join(PACKAGE_ROOT, "index.ts"),
    [
      'export const externalDemo = { id: "external-demo", version: "0.1.0" };',
      "export async function captureFromTurn() {",
      '  return { created: ["portable-draft"], existing: [], invalid: [], warnings: [] };',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const status = {
    active_spaces: {
      [sessionId]: {
        space_id: "portable-space",
        records_root: recordsRoot,
        packs: [{
          id: "external-demo",
          version: "0.1.0",
          from: "@engram-portability-test/external-demo",
          extract: true,
        }],
      },
    },
  };
  await writeFile(
    cliPath,
    `#!/usr/bin/env bun\nconsole.log(${JSON.stringify(JSON.stringify(status))});\n`,
    { mode: 0o755 },
  );

  process.env.ENGRAM_BINDING_REGISTRY = registryPath;
  process.env.ENGRAM_CLI = cliPath;
  process.env.ENGRAM_PROJECT_ROOT = root;

  let sessionStopHandler:
    | ((event: SessionStopEvent, context: ExtensionContext) => void | Promise<void>)
    | undefined;
  const infos: string[] = [];
  const warnings: string[] = [];
  const api: ExtensionAPI = {
    on: (_event, handler) => { sessionStopHandler = handler; },
    registerTool: (_tool) => {},
    logger: {
      info: (message) => { infos.push(message); },
      warn: (message) => { warnings.push(message); },
    },
  };

  await engramExtension(api);
  assert.ok(sessionStopHandler !== undefined, "session_stop handler was not registered");
  const controller = new AbortController();
  await sessionStopHandler(
    {
      type: "session_stop",
      messages: [{ role: "user", id: "portable-turn", content: "portability probe" }],
      session_id: sessionId,
      session_file: join(root, "session.jsonl"),
      turn_id: 1,
      stop_hook_active: false,
      signal: controller.signal,
    },
    { cwd: root },
  );

  assert.equal(
    warnings.some((warning) => warning.includes("failed to load pack capture handler")),
    false,
    warnings.join("\n"),
  );
  assert.equal(
    infos.some((message) => message.includes("capture: 1 draft(s)")),
    true,
    infos.join("\n"),
  );
  console.log("bare pack capture succeeded without Node");
} finally {
  for (const key of environmentKeys) {
    const value = environmentBackup.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(PACKAGE_SCOPE, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
