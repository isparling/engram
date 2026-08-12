// Repository-owned release qualification and publication orchestrator for
// R0. The release manager (release/engram-release.ts) never builds source;
// this script is the one place that runs the ordered qualification gates,
// exercises the exact packaged bootstrap against a detached source
// checkout, proves rollback safety with synthetic release trees, and then
// atomically publishes the three-file release set.

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildReleaseCandidate,
  identifyCleanSource,
  releaseArtifactNames,
  type ReleaseCandidate,
} from "./release-builder.ts";
import { inspectStagedFiles } from "./release-archive.ts";
import { defaultQmdCacheHome, defaultQmdConfigDir, isDefaultQmdCacheHome, isDefaultQmdConfigDir } from "../src/qmdConfigGuard.ts";
import { realOrResolvedPath } from "../src/realPath.ts";
import {
  registerSpace,
  selectSpace,
  type ActiveSpaceStatus,
  type SpaceRegistryStatus,
} from "../src/spaceRegistry.ts";
import {
  canonicalReleaseJson,
  installRelease,
  parseReleaseRecord,
  selectRelease,
  type ReleaseManagerOptions,
  type ReleaseRecord,
} from "../../release/engram-release.ts";
import type { EnvLike } from "../src/types.ts";

const execFile = promisify(execFileCallback);

export type QualificationCommandResult = { code: number; stdout: string; stderr: string };

export type QualificationRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: EnvLike },
) => Promise<QualificationCommandResult>;

export type QualificationErrorCode =
  | "manual_content_review_invalid"
  | "source_invalid"
  | "gate_failed"
  | "qmd_binding_unsafe"
  | "qmd_probe_failed"
  | "detached_worktree_failed"
  | "candidate_build_failed"
  | "install_smoke_failed"
  | "select_smoke_failed"
  | "stable_command_failed"
  | "rollback_smoke_failed"
  | "record_invalid"
  | "publication_exists"
  | "publication_failed";

export type QualificationError = { code: QualificationErrorCode; message: string; command?: string };

export type QualificationResult<T> = { ok: true; value: T } | { ok: false; errors: QualificationError[] };

export type QualificationOutput = {
  releaseId: string;
  destination: string;
  archivePath: string;
  bootstrapPath: string;
  recordPath: string;
};

export type QualificationHooks = {
  /** Test seam for deterministically exercising a destination that appears
   * after the optimistic check but before the cooperative publish claim. */
  beforePublicationClaim?: (destination: string) => Promise<void> | void;
};

export type QualifyAndPublishOptions = {
  repoRoot: string;
  qualificationRoot: string;
  outputRoot: string;
  manualContentReview: "passed";
  runner?: QualificationRunner;
  nodeVersion?: string;
  publishedAt?: string;
  hooks?: QualificationHooks;
};

class QualificationFailure extends Error {
  readonly code: QualificationErrorCode;
  readonly command: string | undefined;

  constructor(code: QualificationErrorCode, message: string, command?: string) {
    super(message);
    this.code = code;
    this.command = command;
  }
}

function fail(code: QualificationErrorCode, message: string, command?: string): never {
  throw new QualificationFailure(code, message, command);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Every command this orchestrator runs starts from a copy of the current
// process environment with these keys stripped, so a stale/ambient value
// (a shell that already exports QMD_CONFIG_DIR, or a leftover
// ENGRAM_RELEASE_HOME from an unrelated session) can never survive into an
// invocation this script controls — only the value this script explicitly
// sets for that call is ever present.
const SCOPED_ENV_KEYS: Record<string, true> = {
  QMD_CONFIG_DIR: true,
  XDG_CACHE_HOME: true,
  INDEX_PATH: true,
  ENGRAM_RELEASE_HOME: true,
  ENGRAM_BIN_DIR: true,
  ENGRAM_BINDING_REGISTRY: true,
  ENGRAM_HOST_SESSION_ID: true,
};

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SCOPED_ENV_KEYS[key] !== true) env[key] = value;
  }
  return env;
}

function definedEnv(env: EnvLike): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) result[key] = value;
  return result;
}

/**
 * Production default: execFile, never a shell. Never throws — a spawn
 * failure (ENOENT, etc.) is reported as a non-zero, uncaptured-stdout
 * result rather than an exception, matching the release manager's own
 * GitRunner convention so every gate can be handled uniformly by `run`.
 */
export const defaultQualificationRunner: QualificationRunner = async (command, args, options) => {
  try {
    const result = await execFile(command, [...args], { cwd: options.cwd, env: definedEnv(options.env) });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "number" ? error.code : 1;
    const stdout = error instanceof Error && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    return { code, stdout, stderr };
  }
};

/** Fail-fast wrapper: any non-zero exit or thrown error stops qualification
 * immediately with the given error code, naming the exact command. */
async function run(
  runner: QualificationRunner,
  errorCode: QualificationErrorCode,
  command: string,
  args: readonly string[],
  options: { cwd: string; env: EnvLike },
): Promise<QualificationCommandResult> {
  const label = [command, ...args].join(" ");
  let result: QualificationCommandResult;
  try {
    result = await runner(command, args, options);
  } catch (error) {
    fail(errorCode, `command failed to run: ${label}: ${error instanceof Error ? error.message : String(error)}`, label);
  }
  if (result.code !== 0) fail(errorCode, `command exited ${result.code}: ${label}`, label);
  return result;
}

function parseExactManagerResult(raw: string, status: "installed" | "selected", errorCode: "install_smoke_failed" | "select_smoke_failed"): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(errorCode, `bootstrap ${status} produced invalid JSON`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 ||
    !("schema_version" in parsed) ||
    !("status" in parsed) ||
    parsed.schema_version !== 0 ||
    parsed.status !== status
  ) {
    fail(errorCode, `bootstrap ${status} did not produce its exact success projection`);
  }
}

function parseExactCurrentResult(raw: string, expectedReleaseId: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("stable_command_failed", "engram-release current produced invalid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 3 ||
    !("schema_version" in parsed) ||
    !("status" in parsed) ||
    !("release_id" in parsed) ||
    parsed.schema_version !== 0 ||
    parsed.status !== "current" ||
    parsed.release_id !== expectedReleaseId
  ) {
    fail("stable_command_failed", "engram-release current did not produce the exact selected-release projection");
  }
}

function assertNoSourcePaths(result: QualificationCommandResult, forbidden: readonly string[], context: string): void {
  for (const path of forbidden) {
    if (result.stdout.includes(path) || result.stderr.includes(path)) {
      fail("stable_command_failed", `${context} output references a development or detached source checkout path`, context);
    }
  }
}

async function assertLauncherClean(launcherPath: string, forbidden: readonly string[]): Promise<void> {
  let content: string;
  try {
    content = await readFile(launcherPath, "utf8");
  } catch (error) {
    fail("install_smoke_failed", `installed launcher cannot be read: ${launcherPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const path of forbidden) {
    if (content.includes(path)) fail("install_smoke_failed", `installed launcher references a development or detached source checkout path: ${launcherPath}`);
  }
}
type SyntheticQmdBinding = {
  qmdConfigDir: string;
  qmdCacheHome: string;
  qmdCacheHomeCanonical: string;
  qmdCollectionName: string;
  registryPath: string;
  spaceId: string;
  hostSessionId: string;
};

/**
 * Creates one complete, fictional bound space under the qualification
 * root. It never invokes qmd update/embed: the valid config only lets the
 * status probe prove qmd is reachable under a non-ambient scope without
 * indexing anything, while register/select makes the later stable `engram
 * space status` command inspect that same one selected synthetic space
 * rather than an empty registry that exercises no binding boundary.
 */
async function createSyntheticQmdBinding(qualificationRoot: string): Promise<SyntheticQmdBinding> {
  const spaceRoot = join(qualificationRoot, "synthetic-space");
  const recordsRoot = join(spaceRoot, "records");
  const sessionsDir = join(spaceRoot, "sessions");
  const qmdConfigDir = join(spaceRoot, "qmd-config");
  const qmdCacheHome = join(spaceRoot, "qmd-cache");
  const registryPath = join(qualificationRoot, "space-registry.json");
  const manifestPath = join(spaceRoot, "space.json");
  const bindingPath = join(spaceRoot, "binding.json");
  const spaceId = "r0-qualification-space";
  const hostSessionId = "r0-qualification-session";
  const qmdCollectionName = "r0-qualification";
  await Promise.all([
    mkdir(recordsRoot, { recursive: true }),
    mkdir(sessionsDir, { recursive: true }),
    mkdir(qmdConfigDir, { recursive: true }),
    mkdir(qmdCacheHome, { recursive: true }),
  ]);
  const canonicalRecordsRoot = await realOrResolvedPath(recordsRoot);
  await writeFile(
    join(qmdConfigDir, "index.yml"),
    `collections:\n  ${qmdCollectionName}:\n    path: ${JSON.stringify(canonicalRecordsRoot)}\n    pattern: \"*.md\"\n`,
    { flag: "wx" },
  );
  await writeFile(
    manifestPath,
    JSON.stringify({
      schema_version: 0,
      space_id: spaceId,
      knowledge_schema_version: "0",
      records_dir: "records",
      required_packs: [{ id: "fictional-integrity", version: "0.1.0" }],
    }),
    { flag: "wx" },
  );
  await writeFile(
    bindingPath,
    JSON.stringify({
      schema_version: 0,
      manifest_path: manifestPath,
      qmd_config_dir: qmdConfigDir,
      qmd_cache_home: qmdCacheHome,
      qmd_collection_name: qmdCollectionName,
      sessions_dir: sessionsDir,
      read_roots: [spaceRoot],
      write_roots: [spaceRoot],
      provider_policy: {
        allowed_models: ["fictional-provider/fictional-model"],
        credential_env: ["FICTIONAL_PROVIDER_TOKEN"],
      },
      installed_packs: [{ id: "fictional-integrity", version: "0.1.0" }],
    }),
    { flag: "wx" },
  );

  const [canonicalRoot, canonicalConfig, canonicalCache] = await Promise.all([
    realOrResolvedPath(qualificationRoot),
    realOrResolvedPath(qmdConfigDir),
    realOrResolvedPath(qmdCacheHome),
  ]);
  const rootPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
  if (!canonicalConfig.startsWith(rootPrefix) || !canonicalCache.startsWith(rootPrefix)) {
    fail("qmd_binding_unsafe", "synthetic qmd binding escapes the qualification root");
  }
  if (await isDefaultQmdConfigDir(qmdConfigDir)) {
    fail("qmd_binding_unsafe", `synthetic qmd config dir resolves to the machine default (${defaultQmdConfigDir()})`);
  }
  if (await isDefaultQmdCacheHome(qmdCacheHome)) {
    fail("qmd_binding_unsafe", `synthetic qmd cache home resolves to the machine default (${defaultQmdCacheHome()})`);
  }

  const registered = await registerSpace(registryPath, bindingPath);
  if (!registered.ok) fail("qmd_binding_unsafe", `synthetic space registration failed: ${registered.errors.join("; ")}`);
  const selected = await selectSpace(registryPath, spaceId, hostSessionId);
  if (!selected.ok) fail("qmd_binding_unsafe", `synthetic space selection failed: ${selected.errors.join("; ")}`);
  return { qmdConfigDir, qmdCacheHome, qmdCacheHomeCanonical: canonicalCache, qmdCollectionName, registryPath, spaceId, hostSessionId };
}

/** The packaged candidate must not inherit the caller's credentials,
 * qmd/host state, shell options, or arbitrary variables. Gate commands
 * intentionally retain `baseEnv()` for the repository toolchain; smoke
 * commands get only this deterministic environment and their synthetic
 * binding overrides. */
async function smokeEnv(qualificationRoot: string, overrides: Record<string, string> = {}): Promise<Record<string, string>> {
  const home = join(qualificationRoot, "smoke-home");
  const temporary = join(qualificationRoot, "smoke-tmp");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(temporary, { recursive: true })]);
  return { PATH: dirname(process.execPath), HOME: home, TMPDIR: temporary, ...overrides };
}

// The installed `engram space status` must report exactly the REAL registry
// projection (SpaceRegistryStatus / ActiveSpaceStatus in
// harness/src/spaceRegistry.ts): schema_version 0, the registered synthetic
// space, one active session bound to it, a 13-key active-space status whose
// roots all fall under the qualification root. The expected key sets are
// derived from the exported contract types — adding a field to either type
// without also listing it in the Record literal below is a compile-time
// error (missing property), and a stale fixture-shaped projection is a
// runtime refusal — so a future contract change cannot silently pass.
const SPACE_REGISTRY_STATUS_SCHEMA: Record<keyof SpaceRegistryStatus, true> = {
  schema_version: true,
  registered_spaces: true,
  active_spaces: true,
  last_boundary_error: true,
};

const ACTIVE_SPACE_STATUS_SCHEMA: Record<keyof ActiveSpaceStatus, true> = {
  allowed_models: true,
  compatibility: true,
  knowledge_schema_version: true,
  packs: true,
  qmd: true,
  qmd_freshness: true,
  read_roots: true,
  records_root: true,
  session_boundary: true,
  sessions_dir: true,
  space_id: true,
  space_root: true,
  write_roots: true,
};

const QMD_STATUS_SCHEMA: Record<"collection" | "config_dir" | "cache_home", true> = {
  collection: true,
  config_dir: true,
  cache_home: true,
};

function exactKeysOf(schema: Record<string, true>): string[] {
  return Object.keys(schema);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) return undefined;
    result.push(entry);
  }
  return result;
}

function validPackList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const pack of value) {
    if (typeof pack !== "object" || pack === null || Array.isArray(pack)) return false;
    if (Object.keys(pack).length !== 2) return false;
    if (!("id" in pack) || typeof pack.id !== "string" || pack.id.length === 0) return false;
    if (!("version" in pack) || typeof pack.version !== "string" || pack.version.length === 0) return false;
  }
  return true;
}

async function assertSyntheticSpaceStatus(raw: string, binding: SyntheticQmdBinding, qualificationRoot: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("stable_command_failed", "engram space status produced invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("stable_command_failed", "engram space status produced an invalid schema");
  }
  const actualStatusKeys = Object.keys(parsed);
  const expectedStatusKeys = exactKeysOf(SPACE_REGISTRY_STATUS_SCHEMA);
  if (
    actualStatusKeys.length !== expectedStatusKeys.length ||
    !expectedStatusKeys.every((key) => actualStatusKeys.includes(key))
  ) {
    fail("stable_command_failed", "engram space status did not report exactly the registered synthetic active space");
  }
  const schemaVersion = "schema_version" in parsed ? parsed.schema_version : undefined;
  const registered = "registered_spaces" in parsed ? parsed.registered_spaces : undefined;
  const active = "active_spaces" in parsed ? parsed.active_spaces : undefined;
  const boundary = "last_boundary_error" in parsed ? parsed.last_boundary_error : undefined;
  if (
    schemaVersion !== 0 ||
    !Array.isArray(registered) ||
    registered.length !== 1 ||
    registered[0] !== binding.spaceId ||
    typeof active !== "object" ||
    active === null ||
    Array.isArray(active) ||
    Object.keys(active).length !== 1 ||
    !(binding.hostSessionId in active) ||
    boundary !== null
  ) {
    fail("stable_command_failed", "engram space status did not report exactly the registered synthetic active space");
  }
  const activeStatus = Object.entries(active).find(([sessionId]) => sessionId === binding.hostSessionId)?.[1];
  if (typeof activeStatus !== "object" || activeStatus === null || Array.isArray(activeStatus)) {
    fail("stable_command_failed", "engram space status did not bind the synthetic host session to its selected space");
  }

  // Real ActiveSpaceStatus contract: exactly the exported key set, the qmd
  // sub-object with exactly its three keys, and the meaningful bindings.
  const activeKeys = Object.keys(activeStatus);
  const expectedActiveKeys = exactKeysOf(ACTIVE_SPACE_STATUS_SCHEMA);
  if (activeKeys.length !== expectedActiveKeys.length || !expectedActiveKeys.every((key) => activeKeys.includes(key))) {
    fail("stable_command_failed", "engram space status did not report the real active-space contract for the synthetic session");
  }
  const qmdField = "qmd" in activeStatus ? activeStatus.qmd : undefined;
  if (typeof qmdField !== "object" || qmdField === null || Array.isArray(qmdField)) {
    fail("stable_command_failed", "engram space status did not report the real qmd binding for the synthetic session");
  }
  const qmdKeys = Object.keys(qmdField);
  const expectedQmdKeys = exactKeysOf(QMD_STATUS_SCHEMA);
  if (qmdKeys.length !== expectedQmdKeys.length || !expectedQmdKeys.every((key) => qmdKeys.includes(key))) {
    fail("stable_command_failed", "engram space status did not report the real qmd binding for the synthetic session");
  }
  const qmdCollection = "collection" in qmdField ? qmdField.collection : undefined;
  if (qmdCollection !== binding.qmdCollectionName) {
    fail("stable_command_failed", "engram space status did not bind the synthetic qmd collection");
  }
  const spaceId = "space_id" in activeStatus ? activeStatus.space_id : undefined;
  if (spaceId !== binding.spaceId) {
    fail("stable_command_failed", "engram space status did not bind the synthetic host session to its selected space");
  }
  // Every root the projection names must resolve strictly beneath the
  // qualification root (symlinks canonicalized the same way the real CLI
  // and createSyntheticQmdBinding resolve them), so a projection pointing
  // anywhere else cannot be mistaken for the synthetic bound space.
  const canonicalRoot = await realOrResolvedPath(qualificationRoot);
  const rootPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
  const beneathQualificationRoot = async (value: unknown, label: string): Promise<void> => {
    if (typeof value !== "string" || value.length === 0) {
      fail("stable_command_failed", `engram space status reported an invalid ${label}`);
    }
    const canonical = await realOrResolvedPath(value);
    if (!canonical.startsWith(rootPrefix)) {
      fail("stable_command_failed", `engram space status bound ${label} outside the qualification root`);
    }
  };
  await Promise.all([
    beneathQualificationRoot("space_root" in activeStatus ? activeStatus.space_root : undefined, "space_root"),
    beneathQualificationRoot("records_root" in activeStatus ? activeStatus.records_root : undefined, "records_root"),
    beneathQualificationRoot("sessions_dir" in activeStatus ? activeStatus.sessions_dir : undefined, "sessions_dir"),
    beneathQualificationRoot("config_dir" in qmdField ? qmdField.config_dir : undefined, "qmd.config_dir"),
    beneathQualificationRoot("cache_home" in qmdField ? qmdField.cache_home : undefined, "qmd.cache_home"),
  ]);
  const readRoots = stringList("read_roots" in activeStatus ? activeStatus.read_roots : undefined);
  const writeRoots = stringList("write_roots" in activeStatus ? activeStatus.write_roots : undefined);
  if (readRoots === undefined) fail("stable_command_failed", "engram space status reported an invalid read_roots list");
  if (writeRoots === undefined) fail("stable_command_failed", "engram space status reported an invalid write_roots list");
  for (const root of readRoots) await beneathQualificationRoot(root, "read_root");
  for (const root of writeRoots) await beneathQualificationRoot(root, "write_root");
  const allowedModels = stringList("allowed_models" in activeStatus ? activeStatus.allowed_models : undefined);
  if (allowedModels === undefined) fail("stable_command_failed", "engram space status reported an invalid allowed_models list");
  const knowledgeSchemaVersion = "knowledge_schema_version" in activeStatus ? activeStatus.knowledge_schema_version : undefined;
  if (typeof knowledgeSchemaVersion !== "string" || knowledgeSchemaVersion.length === 0) {
    fail("stable_command_failed", "engram space status reported an invalid knowledge_schema_version");
  }
  const packs = "packs" in activeStatus ? activeStatus.packs : undefined;
  if (!validPackList(packs)) fail("stable_command_failed", "engram space status reported an invalid installed packs list");
  const compatibility = "compatibility" in activeStatus ? activeStatus.compatibility : undefined;
  if (compatibility !== "compatible") fail("stable_command_failed", "engram space status did not report the active space as compatible");
  const sessionBoundary = "session_boundary" in activeStatus ? activeStatus.session_boundary : undefined;
  if (sessionBoundary !== "validated-not-enforced") {
    fail("stable_command_failed", "engram space status did not report the session boundary as validated-not-enforced");
  }
  const qmdFreshness = "qmd_freshness" in activeStatus ? activeStatus.qmd_freshness : undefined;
  if (qmdFreshness !== "unknown" && qmdFreshness !== "fresh" && qmdFreshness !== "index-stale") {
    fail("stable_command_failed", "engram space status reported an invalid qmd_freshness");
  }
}

/**
 * The installed qmd CLI exposes no version flag (`qmd --version` prints
 * usage and exits 1; `qmd version` is unknown), so this is the R0
 * qualification probe: `qmd status` is read-only and performs no
 * indexing, yet — unlike a version string — its output actually proves
 * the synthetic scoping by naming the bound collection and reporting an
 * index path beneath the scoped cache home. Only a pass/fail is derived
 * here; probe stdout, absolute paths, and environment values are never
 * copied into the manifest or release record.
 */
function assertScopedQmdStatus(raw: string, binding: SyntheticQmdBinding): void {
  const indexPath = raw.match(/^Index:[ \t]+(\S.*)$/m)?.[1]?.trim();
  if (indexPath === undefined || indexPath.length === 0) {
    fail("qmd_probe_failed", "qmd status did not report an index path");
  }
  const cacheHomePrefixes = [binding.qmdCacheHome, binding.qmdCacheHomeCanonical].map((home) =>
    home.endsWith(sep) ? home : `${home}${sep}`,
  );
  if (!cacheHomePrefixes.some((prefix) => indexPath.startsWith(prefix))) {
    fail("qmd_probe_failed", "qmd status reported an index path outside the scoped qmd cache home");
  }
  if (!raw.includes(binding.qmdCollectionName)) {
    fail("qmd_probe_failed", "qmd status did not name the synthetic bound collection");
  }
}

// Focused evidence makes the properties covered by the executed complete
// Node suite auditable without falsely claiming that each standalone
// command was separately run after `npm test`.
const FOCUSED_EVIDENCE_LABELS: readonly string[] = [
  "covered by executed npm test: test/knowledgeTransaction.test.ts (transaction restoration)",
  "covered by executed npm test: test/spaceBinding.test.ts (explicit binding)",
  'covered by executed npm test: test/spaceRegistry.test.ts (cross-space denial: "a knowledge operation resolves only the selected space for the current host session")',
  'covered by executed npm test: test/releaseManager.test.ts (install: "bootstrap installs and selects a release after the development checkout is unavailable")',
  'covered by executed npm test: test/releaseManager.test.ts (rollback: "rollback reselects the previous immutable release")',
];

async function buildRollbackTree(
  scratchRoot: string,
  label: string,
  nodeVersion: string,
): Promise<{ archivePath: string; recordPath: string; releaseId: string }> {
  const root = join(scratchRoot, `rollback-source-${label}`);
  const runnableBinEngram = `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const here = dirname(new URL(import.meta.url).pathname);
const manifest = JSON.parse(await readFile(join(here, '..', 'release-manifest.json'), 'utf8'));
console.log(JSON.stringify({ release_id: manifest.version }));
// synthetic rollback fixture ${label}
`;
  const files: readonly [string, string, boolean?][] = [
    ["bin/engram", runnableBinEngram, true],
    ["harness/src/cli.ts", `export const rollbackFixtureCli = ${JSON.stringify(label)};\n`],
    ["release/engram-release.ts", `export const rollbackFixtureManager = ${JSON.stringify(label)};\n`],
  ];
  for (const [path, content, executable] of files) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
    if (executable) await chmod(destination, 0o755);
  }
  const git = async (args: string[]): Promise<string> => (await execFile("git", args, { cwd: root })).stdout;
  await git(["init", "--quiet"]);
  await git(["config", "commit.gpgsign", "false"]);
  await git(["config", "user.email", "r0-qualification@example.invalid"]);
  await git(["config", "user.name", "R0 Qualification"]);
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", `synthetic rollback tree ${label}`]);
  const revision = (await git(["rev-parse", "HEAD"])).trim();

  const candidateRoot = join(scratchRoot, `rollback-candidate-${label}`);
  const built = await buildReleaseCandidate({
    repoRoot: root,
    stageRoot: join(scratchRoot, `rollback-stage-${label}`),
    outputRoot: candidateRoot,
    sourceRevision: revision,
    nodeVersion,
    qmdVersion: "qmd synthetic-rollback-0",
  });
  const names = releaseArtifactNames(revision);
  const recordPath = join(candidateRoot, names.recordName);
  await writeFile(recordPath, canonicalReleaseJson(built.record), "utf8");
  return { archivePath: built.archivePath, recordPath, releaseId: built.releaseId };
}

async function hashReleaseTree(releasesDir: string, id: string): Promise<string> {
  const entries = await inspectStagedFiles(join(releasesDir, id));
  const summary = entries
    .map((entry) => ({ path: entry.path, executable: entry.executable, sha256: sha256(entry.bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256(Buffer.from(canonicalReleaseJson(summary), "utf8"));
}

export async function qualifyAndPublishR0(options: QualifyAndPublishOptions): Promise<QualificationResult<QualificationOutput>> {
  const runner = options.runner ?? defaultQualificationRunner;
  try {
    if (options.manualContentReview !== "passed") {
      fail("manual_content_review_invalid", 'manual content review must be exactly "passed"');
    }

    const repoRoot = resolve(options.repoRoot);
    const qualificationRoot = resolve(options.qualificationRoot);
    const outputRoot = resolve(options.outputRoot);
    await mkdir(qualificationRoot, { recursive: true });

    // 1. Refuse a dirty or unidentified source revision.
    const cleanSource = await identifyCleanSource(repoRoot);
    if (!cleanSource.ok) fail("source_invalid", cleanSource.error.message);
    const sourceRevision = cleanSource.sourceRevision;
    const nodeVersion = options.nodeVersion ?? process.versions.node;
    const harnessRoot = join(repoRoot, "harness");

    // 2-4. Complete Node suite, strict typecheck, complete mutation registry.
    await run(runner, "gate_failed", "npm", ["test"], { cwd: harnessRoot, env: baseEnv() });
    await run(runner, "gate_failed", "npm", ["run", "typecheck"], { cwd: harnessRoot, env: baseEnv() });
    await run(runner, "gate_failed", "npm", ["run", "mutation-check"], { cwd: harnessRoot, env: baseEnv() });

    // Mutation qualification itself must not have modified the release
    // source. Re-identify immediately before qmd/worktree and require the
    // exact revision that passed the initial attribution gate.
    const postGateSource = await identifyCleanSource(repoRoot);
    if (!postGateSource.ok || postGateSource.sourceRevision !== sourceRevision) {
      fail("source_invalid", "source changed or became unidentifiable during qualification gates");
    }

    // 5. Synthetic bound-space qmd config/cache; 6. observe qmd status
    // under that explicit scope. The installed qmd CLI exposes no version
    // flag, so `qmd status` — read-only, no indexing — is the probe that
    // proves the synthetic binding instead.
    const binding = await createSyntheticQmdBinding(qualificationRoot);
    const qmdEnv = { ...baseEnv(), QMD_CONFIG_DIR: binding.qmdConfigDir, XDG_CACHE_HOME: binding.qmdCacheHome };
    const qmdStatusResult = await run(runner, "qmd_probe_failed", "qmd", ["status"], { cwd: qualificationRoot, env: qmdEnv });
    assertScopedQmdStatus(qmdStatusResult.stdout, binding);
    const qmdVersion = "unversioned-cli";

    // 7-10. Create a detached source worktree, stage/inspect/archive and
    // write the candidate record from it, then remove the worktree before
    // any installed command runs. Once `add` succeeds, the finally block
    // makes removal mandatory on every later failure; a staging failure
    // keeps its primary error while a cleanup failure is surfaced only
    // when cleanup is the sole failure.
    const detachedDir = join(qualificationRoot, "detached-source");
    await run(runner, "detached_worktree_failed", "git", ["worktree", "add", "--detach", detachedDir, sourceRevision], {
      cwd: repoRoot,
      env: baseEnv(),
    });
    let primaryDetachedFailure: unknown;
    const detachedBuild = await (async () => {
      let worktreePresent = true;
      try {
        const [canonicalRepoRoot, canonicalDetachedDir] = await Promise.all([
          realOrResolvedPath(repoRoot),
          realOrResolvedPath(detachedDir),
        ]);
        const forbiddenSourcePaths = [repoRoot, canonicalRepoRoot, detachedDir, canonicalDetachedDir];
        const candidateOutputRoot = join(qualificationRoot, "candidate");
        let candidate: ReleaseCandidate;
        try {
          candidate = await buildReleaseCandidate({
            repoRoot: detachedDir,
            stageRoot: join(qualificationRoot, "stage"),
            outputRoot: candidateOutputRoot,
            sourceRevision,
            nodeVersion,
            qmdVersion,
            ...(options.publishedAt === undefined ? {} : { publishedAt: options.publishedAt }),
          });
        } catch (error) {
          fail("candidate_build_failed", error instanceof Error ? error.message : String(error));
        }
        const names = releaseArtifactNames(sourceRevision);
        await writeFile(join(candidateOutputRoot, names.recordName), canonicalReleaseJson(candidate.record), "utf8");
        return { candidate, candidateOutputRoot, forbiddenSourcePaths, names };
      } catch (error) {
        primaryDetachedFailure = error;
        throw error;
      } finally {
        if (worktreePresent) {
          try {
            await run(runner, "detached_worktree_failed", "git", ["worktree", "remove", "--force", detachedDir], {
              cwd: repoRoot,
              env: baseEnv(),
            });
            worktreePresent = false;
          } catch (cleanupError) {
            if (primaryDetachedFailure === undefined) throw cleanupError;
          }
        }
      }
    })();
    const { candidate, candidateOutputRoot, forbiddenSourcePaths, names } = detachedBuild;

    // 11-12. Bootstrap install, bootstrap select — cwd outside both
    // checkouts, synthetic-binding-only environment.
    const installHome = join(qualificationRoot, "install-home");
    const installBin = join(qualificationRoot, "install-bin");
    const installEnv = await smokeEnv(qualificationRoot, { ENGRAM_RELEASE_HOME: installHome, ENGRAM_BIN_DIR: installBin });

    const installResult = await run(
      runner,
      "install_smoke_failed",
      "node",
      [names.bootstrapName, "install", names.archiveName, names.recordName],
      { cwd: candidateOutputRoot, env: installEnv },
    );
    parseExactManagerResult(installResult.stdout, "installed", "install_smoke_failed");
    assertNoSourcePaths(installResult, forbiddenSourcePaths, "bootstrap install");

    const selectResult = await run(
      runner,
      "select_smoke_failed",
      "node",
      [names.bootstrapName, "select", candidate.releaseId],
      { cwd: candidateOutputRoot, env: installEnv },
    );
    assertNoSourcePaths(selectResult, forbiddenSourcePaths, "bootstrap select");
    parseExactManagerResult(selectResult.stdout, "selected", "select_smoke_failed");

    await assertLauncherClean(join(installBin, "engram"), forbiddenSourcePaths);
    await assertLauncherClean(join(installBin, "engram-release"), forbiddenSourcePaths);

    // 13. Stable `engram space status` against the same synthetic bound
    // space registered and selected before the qmd-version probe.
    const stableSpaceEnv = await smokeEnv(qualificationRoot, {
      QMD_CONFIG_DIR: binding.qmdConfigDir,
      XDG_CACHE_HOME: binding.qmdCacheHome,
      ENGRAM_BINDING_REGISTRY: binding.registryPath,
      ENGRAM_HOST_SESSION_ID: binding.hostSessionId,
    });
    const statusResult = await run(runner, "stable_command_failed", join(installBin, "engram"), ["space", "status"], {
      cwd: qualificationRoot,
      env: stableSpaceEnv,
    });
    assertNoSourcePaths(statusResult, forbiddenSourcePaths, "engram space status");
    await assertSyntheticSpaceStatus(statusResult.stdout, binding, qualificationRoot);

    // 14. Stable `engram-release current`.
    const currentResult = await run(runner, "stable_command_failed", join(installBin, "engram-release"), ["current"], {
      cwd: qualificationRoot,
      env: installEnv,
    });
    assertNoSourcePaths(currentResult, forbiddenSourcePaths, "engram-release current");
    parseExactCurrentResult(currentResult.stdout, candidate.releaseId);

    // 15. Synthetic A/B/A rollback, with tree hashes before/after and
    // distinct `engram version` outputs.
    const rollbackHome = join(qualificationRoot, "rollback-home");
    const rollbackBin = join(qualificationRoot, "rollback-bin");
    const rollbackOptions: ReleaseManagerOptions = { releaseHome: rollbackHome, binDir: rollbackBin };
    const treeA = await buildRollbackTree(qualificationRoot, "a", nodeVersion);
    const treeB = await buildRollbackTree(qualificationRoot, "b", nodeVersion);
    if (treeA.releaseId === treeB.releaseId) fail("rollback_smoke_failed", "synthetic rollback trees must have distinct release identifiers");

    const installA = await installRelease(treeA.archivePath, treeA.recordPath, rollbackOptions);
    if (!installA.ok) fail("rollback_smoke_failed", "failed to install synthetic rollback release A");
    const installB = await installRelease(treeB.archivePath, treeB.recordPath, rollbackOptions);
    if (!installB.ok) fail("rollback_smoke_failed", "failed to install synthetic rollback release B");

    const releasesDir = join(rollbackHome, "releases");
    const hashA0 = await hashReleaseTree(releasesDir, treeA.releaseId);
    const hashB0 = await hashReleaseTree(releasesDir, treeB.releaseId);
    const rollbackEnv = await smokeEnv(qualificationRoot);

    const selectAndObserve = async (id: string): Promise<void> => {
      const selected = await selectRelease(id, rollbackOptions);
      if (!selected.ok) fail("rollback_smoke_failed", `failed to select synthetic rollback release ${id}`);
      const versionResult = await run(runner, "rollback_smoke_failed", join(rollbackBin, "engram"), ["version"], {
        cwd: qualificationRoot,
        env: rollbackEnv,
      });
      let observed: unknown;
      try {
        observed = JSON.parse(versionResult.stdout);
      } catch {
        fail("rollback_smoke_failed", "engram version produced invalid JSON during rollback qualification");
      }
      const observedId =
        typeof observed === "object" && observed !== null && "release_id" in observed ? observed.release_id : undefined;
      if (observedId !== id) fail("rollback_smoke_failed", `engram version reported ${String(observedId)}, expected ${id}`);
    };

    await selectAndObserve(treeA.releaseId);
    if ((await hashReleaseTree(releasesDir, treeB.releaseId)) !== hashB0) fail("rollback_smoke_failed", "selecting release A modified release B's tree");
    await selectAndObserve(treeB.releaseId);
    if ((await hashReleaseTree(releasesDir, treeA.releaseId)) !== hashA0) fail("rollback_smoke_failed", "selecting release B modified release A's tree");
    await selectAndObserve(treeA.releaseId);
    if ((await hashReleaseTree(releasesDir, treeA.releaseId)) !== hashA0 || (await hashReleaseTree(releasesDir, treeB.releaseId)) !== hashB0) {
      fail("rollback_smoke_failed", "A/B/A rollback modified an immutable release tree");
    }

    // 16. Append exact-byte evidence without changing archive/bootstrap bytes.
    const archiveHash = candidate.archiveIntegrity.sha256;
    const evidence = (command: string, outcome: "passed" | "not_applicable" = "passed", mode: "automated" | "manual" = "automated") => ({
      command,
      outcome,
      mode,
      artifact_sha256: archiveHash,
    });
    const finalRecord: ReleaseRecord = {
      ...candidate.record,
      verification_summary: [
        ...candidate.record.verification_summary,
        evidence("npm test"),
        evidence("npm run typecheck"),
        evidence("npm run mutation-check"),
        ...FOCUSED_EVIDENCE_LABELS.map((label) => evidence(label)),
        evidence("qmd status"),
        evidence(`node ${names.bootstrapName} install ${names.archiveName} ${names.recordName}`),
        evidence(`node ${names.bootstrapName} select ${candidate.releaseId}`),
        evidence("engram space status"),
        evidence("engram-release current"),
        evidence(`synthetic A/B/A rollback (${treeA.releaseId} -> ${treeB.releaseId} -> ${treeA.releaseId})`),
        evidence("manual content review", "passed", "manual"),
        evidence("synthetic R0 benchmark suite", "not_applicable"),
      ],
      known_limitations: [
        ...candidate.record.known_limitations,
        "R0 defines no separate synthetic benchmark set; the corresponding verification entry records not_applicable rather than a fabricated result.",
        "The installed qmd CLI exposes no version identifier, so qmd compatibility is contract-only.",
      ],
    };
    const validated = parseReleaseRecord(finalRecord);
    if (!validated.ok) fail("record_invalid", `final release record failed validation: ${validated.errors.map((error) => error.message).join("; ")}`);

    // 17. Finalize exact bytes, then publish a same-filesystem three-file
    // set under a cooperative claim. `rename` may replace an empty
    // destination on this platform, so an optimistic lstat alone is not a
    // publication boundary: claim first, then recheck immediately before
    // rename, and refuse every observed destination.
    const archiveBytes = await readFile(candidate.archivePath);
    const bootstrapBytes = await readFile(candidate.bootstrapPath);
    const archiveIntegrity = validated.value.artifact_integrity.archive;
    const bootstrapIntegrity = validated.value.artifact_integrity.bootstrap;
    if (
      archiveBytes.length !== archiveIntegrity.byte_length ||
      sha256(archiveBytes) !== archiveIntegrity.sha256 ||
      bootstrapBytes.length !== bootstrapIntegrity.byte_length ||
      sha256(bootstrapBytes) !== bootstrapIntegrity.sha256
    ) {
      fail("record_invalid", "candidate artifact bytes no longer match the validated release record");
    }
    const recordBytes = Buffer.from(canonicalReleaseJson(validated.value), "utf8");
    const destination = join(outputRoot, candidate.releaseId);
    const claimPath = join(outputRoot, `.${candidate.releaseId}.publish-claim`);
    await mkdir(outputRoot, { recursive: true });
    const destinationExists = async (): Promise<boolean> => {
      try {
        await lstat(destination);
        return true;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code === "ENOENT") return false;
        fail("publication_failed", `final release destination cannot be inspected: ${destination}`);
      }
    };
    if (await destinationExists()) fail("publication_exists", `release destination already exists: ${destination}`);
    await options.hooks?.beforePublicationClaim?.(destination);
    if (await destinationExists()) fail("publication_exists", `release destination already exists: ${destination}`);
    try {
      await mkdir(claimPath, { mode: 0o700 });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "EEXIST") fail("publication_exists", `another qualification holds the release publication claim: ${destination}`);
      fail("publication_failed", `release publication claim cannot be created: ${destination}`);
    }

    let tempDir: string | undefined;
    try {
      if (await destinationExists()) fail("publication_exists", `release destination already exists: ${destination}`);
      tempDir = await mkdtemp(join(outputRoot, `.${candidate.releaseId}.publish-`));
      const publishFiles: readonly [string, Buffer][] = [
        [names.archiveName, archiveBytes],
        [names.bootstrapName, bootstrapBytes],
        [names.recordName, recordBytes],
      ];
      for (const [name, bytes] of publishFiles) {
        const handle = await open(join(tempDir, name), "wx", 0o644);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      const dirHandle = await open(tempDir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
      if (await destinationExists()) fail("publication_exists", `release destination already exists: ${destination}`);
      await rename(tempDir, destination);
      tempDir = undefined;
    } catch (error) {
      if (error instanceof QualificationFailure) throw error;
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "ENOTEMPTY" || code === "EEXIST") fail("publication_exists", `release destination already exists: ${destination}`);
      fail("publication_failed", `failed to publish release set: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
      await rm(claimPath, { recursive: true, force: true });
    }

    return {
      ok: true,
      value: {
        releaseId: candidate.releaseId,
        destination,
        archivePath: join(destination, names.archiveName),
        bootstrapPath: join(destination, names.bootstrapName),
        recordPath: join(destination, names.recordName),
      },
    };
  } catch (error) {
    if (error instanceof QualificationFailure) {
      return {
        ok: false,
        errors: [{ code: error.code, message: error.message, ...(error.command === undefined ? {} : { command: error.command }) }],
      };
    }
    return { ok: false, errors: [{ code: "candidate_build_failed", message: error instanceof Error ? error.message : String(error) }] };
  }
}

function usageError(): never {
  process.stderr.write("usage: release.ts --manual-content-review passed\n");
  process.exit(1);
}

function parseCliArgs(argv: readonly string[]): { manualContentReview: "passed" } {
  if (argv.length !== 2 || argv[0] !== "--manual-content-review" || argv[1] !== "passed") usageError();
  return { manualContentReview: "passed" };
}

const modulePath = fileURLToPath(import.meta.url);
let invokedEntrypoint: string | undefined;
try {
  invokedEntrypoint = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
} catch {
  invokedEntrypoint = undefined;
}
if (invokedEntrypoint === modulePath) {
  if (process.versions.bun !== undefined) {
    void execFile("node", [process.argv[1] ?? modulePath, ...process.argv.slice(2)], { env: definedEnv(baseEnv()) })
      .then(({ stdout, stderr }) => {
        process.stdout.write(stdout);
        process.stderr.write(stderr);
      })
      .catch((error) => {
        const stdout = error instanceof Error && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
        const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
        process.stdout.write(stdout);
        process.stderr.write(stderr);
        process.exitCode = error instanceof Error && "code" in error && typeof error.code === "number" ? error.code : 1;
      });
  } else {
    const { manualContentReview } = parseCliArgs(process.argv.slice(2));
    const repoRoot = resolve(dirname(modulePath), "..", "..");
    const outputRoot = join(repoRoot, "release-output");
    void (async () => {
      const qualificationRoot = await mkdtemp(join(tmpdir(), "engram-r0-qualification-"));
      try {
        const result = await qualifyAndPublishR0({ repoRoot, qualificationRoot, outputRoot, manualContentReview });
        if (result.ok) {
          process.stdout.write(`${JSON.stringify({ schema_version: 0, status: "published", release_id: result.value.releaseId, destination: result.value.destination })}\n`);
          process.exitCode = 0;
        } else {
          process.stderr.write(`${JSON.stringify({ schema_version: 0, status: "failed", errors: result.errors })}\n`);
          process.exitCode = 1;
        }
      } finally {
        await rm(qualificationRoot, { recursive: true, force: true }).catch(() => {});
      }
    })();
  }
}
