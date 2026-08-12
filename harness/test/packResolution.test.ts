// The CLI must resolve its knowledge pack from the active space's declared
// `required_packs`, never from a hardcoded constant. Pack resolution is
// explicit and external-only: `resolveCliPack`
// resolves exactly the declared id/version through the binding's
// `installed_packs[].from` module specifier, and an absent, unmatched, or
// unloadable `from` fails closed rather than falling back to any bundled or
// default resolution. Exercised as a subprocess the same way
// harness/test/cli.test.ts does, so a fixture space's `required_packs` is the
// only thing that can select a pack.
//
// A space's manifest requires `required_packs` to be a non-empty array
// (see spaceRegistry.ts `packVersions`), so "a space declares zero packs"
// can never occur through a real, successfully-resolved ActiveSpace. The
// CLI still refuses that case defensively (see cli.ts `resolveCliPack`),
// but only the "declares more than one" arm of that guard is reachable
// through a real fixture, so only that arm is pinned by a mutation below —
// pinning the unreachable arm would not be a property a test can observe
// fail.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { registerSpace, selectSpace } from "../src/spaceRegistry.ts";
import {
  createUninitializedEphemeralSpace,
  destroyEphemeralSpace,
  type EphemeralSpace,
} from "./testSupport.ts";

const execFileAsync = promisify(execFile);
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures");
const SPACE_A_RECORDS_DIR = join(FIXTURES_DIR, "space-a", "records");

const spacesToClean: EphemeralSpace[] = [];
const scratchDirsToClean: string[] = [];

after(async () => {
  for (const space of spacesToClean) await destroyEphemeralSpace(space);
  for (const dir of scratchDirsToClean) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// The CLI, exercised as a subprocess (mirrors harness/test/cli.test.ts).
// ---------------------------------------------------------------------------

type PackDecl = { id: string; version: string; from?: string };

async function writeBindingFixture(space: EphemeralSpace, spaceId: string, requiredPacks: PackDecl[]): Promise<string> {
  const manifestPath = join(space.root, "space.json");
  const sessionsDir = join(space.root, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      schema_version: 0,
      space_id: spaceId,
      knowledge_schema_version: "0",
      records_dir: "records",
      required_packs: requiredPacks.map(({ id, version }) => ({ id, version })),
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
      provider_policy: {
        allowed_models: ["fictional-provider/fictional-model"],
        credential_env: ["FICTIONAL_PROVIDER_TOKEN"],
      },
      installed_packs: requiredPacks,
    }),
    "utf8",
  );
  return bindingPath;
}

async function runCli(args: string[], registryPath: string, hostSessionId: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ENGRAM_BINDING_REGISTRY: registryPath, ENGRAM_HOST_SESSION_ID: hostSessionId },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function prepareActiveSpace(space: EphemeralSpace, spaceId: string, hostSessionId: string, requiredPacks: PackDecl[]): Promise<string> {
  const registryPath = join(space.root, "registry.json");
  const bindingPath = await writeBindingFixture(space, spaceId, requiredPacks);
  const registered = await registerSpace(registryPath, bindingPath);
  assert.equal(registered.ok, true, `register failed: ${registered.ok ? "" : JSON.stringify(registered.errors)}`);
  const selected = await selectSpace(registryPath, spaceId, hostSessionId);
  assert.equal(selected.ok, true, `select failed: ${selected.ok ? "" : JSON.stringify(selected.errors)}`);
  return registryPath;
}

async function writeCandidateFile(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "engram-pack-resolution-candidate-"));
  scratchDirsToClean.push(dir);
  const path = join(dir, "candidate.json");
  await writeFile(path, JSON.stringify(content), "utf8");
  return path;
}

/** An otherwise valid candidate for the fictional-integrity pack surface, so a
 * submission that fails to resolve the pack can only fail on resolution. */
function fictionalIntegrityCandidate(spaceId: string): Record<string, unknown> {
  return {
    id: "pack-from-required-candidate",
    kind: "claim",
    status: "candidate",
    statement: "Synthetic candidate requiring pack resolution.",
    details: { basis: "test", certainty: "high" },
    scope: {
      space: spaceId,
      subjects: ["subject:fictional"],
      topics: ["topic:resolution"],
      contexts: [],
      dimensions: {},
    },
    pack: { id: "fictional-integrity", version: "0.1.0" },
    sources: [{ type: "test", ref: "pack-from-required" }],
    session: { id: "pack-from-required-session", host: "synthetic-host" },
    submitted_at: "2026-08-12",
    disposition: "new",
  };
}

test("CLI: a space declaring more than one required pack fails closed with a clear error instead of guessing", async () => {
  const space = await createUninitializedEphemeralSpace(SPACE_A_RECORDS_DIR, "pack-resolution-two-packs");
  spacesToClean.push(space);
  const registryPath = await prepareActiveSpace(space, "pack-resolution-two-packs", "pack-resolution-two-packs-session", [
    { id: "fictional-integrity", version: "0.1.0" },
    { id: "fictional-secondary", version: "0.1.0" },
  ]);
  const candidatePath = await writeCandidateFile({});

  const result = await runCli(["knowledge", "submit", "--candidate", candidatePath], registryPath, "pack-resolution-two-packs-session");
  assert.notEqual(result.code, 0);
  const parsed = JSON.parse(result.stdout) as { status: string; errors: string[] };
  assert.equal(parsed.status, "invalid");
  assert.match(parsed.errors.join(" "), new RegExp("declares 2 required " + "pac" + "ks"));
  assert.match(parsed.errors.join(" "), /will not guess which one to use/);
});

test("the CLI fails closed with pack_from_required when the required pack omits from", async () => {
  const space = await createUninitializedEphemeralSpace(SPACE_A_RECORDS_DIR, "pack-resolution-from-required");
  spacesToClean.push(space);
  const spaceId = "pack-resolution-from-required";
  // A binding that declares fictional-integrity@0.1.0 but omits `from` must be
  // refused as pack_from_required: external-only resolution has no bundled
  // registry to fall back to, so the CLI fails closed rather than substituting
  // any pack.
  const registryPath = await prepareActiveSpace(space, spaceId, "pack-resolution-from-required-session", [
    { id: "fictional-integrity", version: "0.1.0" },
  ]);
  const candidatePath = await writeCandidateFile(fictionalIntegrityCandidate(spaceId));

  const result = await runCli(["knowledge", "submit", "--candidate", candidatePath], registryPath, "pack-resolution-from-required-session");
  assert.notEqual(result.code, 0);
  const parsed = JSON.parse(result.stdout) as { status: string; errors: string[] };
  assert.equal(parsed.status, "invalid");
  assert.match(parsed.errors.join(" "), /pack_from_required/);
});

test("CLI: a required pack whose from names a missing module fails closed as pack_load_failed", async () => {
  const space = await createUninitializedEphemeralSpace(SPACE_A_RECORDS_DIR, "pack-resolution-load-failed");
  spacesToClean.push(space);
  const missingFixturePath = join(dirname(fileURLToPath(import.meta.url)), "packLoader.no-such-fixture.ts");
  const registryPath = await prepareActiveSpace(space, "pack-resolution-load-failed", "pack-resolution-load-failed-session", [
    { id: "fictional-integrity", version: "0.1.0", from: missingFixturePath },
  ]);
  const candidatePath = await writeCandidateFile({});

  const result = await runCli(["knowledge", "submit", "--candidate", candidatePath], registryPath, "pack-resolution-load-failed-session");
  assert.notEqual(result.code, 0);
  const parsed = JSON.parse(result.stdout) as { status: string; errors: string[] };
  assert.equal(parsed.status, "invalid");
  assert.match(parsed.errors.join(" "), /pack_load_failed/);
  // The error contract never prints module paths or import stacks.
  assert.ok(!parsed.errors.join(" ").includes(missingFixturePath), "error must not contain the module path");
});

test("CLI: a required pack whose from module identity mismatches the declaration fails closed as pack_identity_mismatch", async () => {
  const space = await createUninitializedEphemeralSpace(SPACE_A_RECORDS_DIR, "pack-resolution-identity-mismatch");
  spacesToClean.push(space);
  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "packLoader.fixture.ts");
  // The fixture's default export declares fictional-integrity@9.9.9, which
  // does not match the binding's declared fictional-integrity@0.1.0.
  const registryPath = await prepareActiveSpace(space, "pack-resolution-identity-mismatch", "pack-resolution-identity-mismatch-session", [
    { id: "fictional-integrity", version: "0.1.0", from: fixturePath },
  ]);
  const candidatePath = await writeCandidateFile({});

  const result = await runCli(["knowledge", "submit", "--candidate", candidatePath], registryPath, "pack-resolution-identity-mismatch-session");
  assert.notEqual(result.code, 0);
  const parsed = JSON.parse(result.stdout) as { status: string; errors: string[] };
  assert.equal(parsed.status, "invalid");
  assert.match(parsed.errors.join(" "), /pack_identity_mismatch/);
  // The error contract never prints module paths or import stacks.
  assert.ok(!parsed.errors.join(" ").includes(fixturePath), "error must not contain the module path");
});

test("property: knowledge submit with external pack via from field resolves the pack rather than pack_unknown", async () => {
  const space = await createUninitializedEphemeralSpace(SPACE_A_RECORDS_DIR, "pack-resolution-external-from");
  spacesToClean.push(space);
  const spaceId = "pack-resolution-external-from";
  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "packLoader.fixture.ts");
  const registryPath = await prepareActiveSpace(space, spaceId, "pack-resolution-external-from-session", [
    { id: "external-demo", version: "0.1.0", from: fixturePath },
  ]);

  const candidatePath = await writeCandidateFile({
    id: "external-demo-candidate",
    kind: "claim",
    status: "candidate",
    statement: "External pack resolves via from field.",
    details: { basis: "test", certainty: "high" },
    scope: {
      space: spaceId,
      subjects: ["subject:fictional"],
      topics: ["topic:external"],
      contexts: [],
      dimensions: {},
    },
    pack: { id: "external-demo", version: "0.1.0" },
    sources: [{ type: "test", ref: "from-resolution" }],
    session: { id: "cli-external-pack-session", host: "synthetic-host" },
    submitted_at: "2026-08-09",
    disposition: "new",
  });

  const result = await runCli(["knowledge", "submit", "--candidate", candidatePath], registryPath, "pack-resolution-external-from-session");
  assert.equal(result.code, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  const parsed = JSON.parse(result.stdout) as { status: string };
  assert.equal(parsed.status, "submitted");
});

test("property: the CLI resolves a relative external pack from the binding that declared it", async () => {
  const space = await createUninitializedEphemeralSpace(SPACE_A_RECORDS_DIR, "pack-resolution-relative-from");
  spacesToClean.push(space);
  const spaceId = "pack-resolution-relative-from";
  await writeFile(
    join(space.root, "relative-pack.mjs"),
    `export default {
  id: "relative-demo",
  version: "0.1.0",
  validateEnvelope() { return { ok: true, value: undefined }; },
  relatedQuery(envelope) { return envelope.statement; },
  reconcile() { return { ok: true, value: { disposition: "new", summary: "synthetic", mutations: [] } }; },
  retrievalPolicy: {
    allowedSourceClasses: ["all"],
    queryStrategy(input) { return input.query; },
    classifySource(source) { return source.type; },
    relevanceThreshold: null,
    isEligible(record) { return record.status === "active"; },
    includePresentations: false,
  },
  views: [],
  audiences: [],
  deliveries: [],
};\n`,
    "utf8",
  );
  const registryPath = await prepareActiveSpace(space, spaceId, "pack-resolution-relative-from-session", [
    { id: "relative-demo", version: "0.1.0", from: "./relative-pack.mjs" },
  ]);
  const candidatePath = await writeCandidateFile({
    ...fictionalIntegrityCandidate(spaceId),
    id: "relative-demo-candidate",
    pack: { id: "relative-demo", version: "0.1.0" },
  });

  const result = await runCli(["knowledge", "submit", "--candidate", candidatePath], registryPath, "pack-resolution-relative-from-session");
  assert.equal(result.code, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  const output: unknown = JSON.parse(result.stdout);
  assert.equal(typeof output === "object" && output !== null && "status" in output ? output.status : undefined, "submitted");
});