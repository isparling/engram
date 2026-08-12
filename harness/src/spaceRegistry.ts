// Portable manifests name logical space content; machine-local bindings supply
// paths and policy; the registry selects one binding for one host-session
// identity. Serialization remains schema_version 0.

import { link, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { atomicWriteFile } from "./atomicWrite.ts";
import { isDefaultQmdCacheHome, isDefaultQmdConfigDir } from "./qmdConfigGuard.ts";
import type { SpaceBinding } from "./spaceBinding.ts";
import { err, ok, type EnvLike, type Result } from "./types.ts";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SUPPORTED_KNOWLEDGE_SCHEMA_VERSIONS = new Set(["0"]);

type PackVersion = {
  id: string;
  version: string;
  /** Module specifier for the externally installed pack. */
  from?: string;
  /** Whether this pack is the designated extraction pack. At most one per binding. */
  extract?: boolean;
};

type SpaceManifest = {
  schemaVersion: 0;
  spaceId: string;
  knowledgeSchemaVersion: string;
  recordsDir: string;
  requiredPacks: PackVersion[];
};

type ProviderPolicy = {
  allowedModels: string[];
  credentialEnv: string[];
};

type LocalBinding = {
  manifestPath: string;
  qmdConfigDir: string;
  qmdCacheHome: string;
  qmdCollectionName: string;
  sessionsDir: string;
  // Registration validates these roots. Runtime protected-root enforcement is
  // intentionally deferred; current record operations stay
  // confined to the validated recordsRoot.
  readRoots: string[];
  writeRoots: string[];
  providerPolicy: ProviderPolicy;
  installedPacks: PackVersion[];
};

export type ActiveSpace = SpaceBinding & {
  spaceId: string;
  spaceRoot: string;
  manifestPath: string;
  bindingPath: string;
  sessionsDir: string;
  readRoots: string[];
  writeRoots: string[];
  allowedModels: string[];
  credentialEnv: string[];
  knowledgeSchemaVersion: string;
  packs: PackVersion[];
};

type RegisteredBoundary = {
  space_root: string;
  records_root: string;
  qmd_config_dir: string;
  qmd_cache_home: string;
  qmd_collection_name: string;
  sessions_dir: string;
};

type RegistryEntry = {
  space_id: string;
  binding_path: string;
  binding_hash: string;
  boundary: RegisteredBoundary;
};

type SpaceState = {
  qmd_freshness: "unknown" | "fresh" | "index-stale";
};

type RegistryLockOwner = {
  schema_version: 0;
  pid: number;
  hostname: string;
  token: string;
  purpose?: "recovery";
};

type RegistryDocument = {
  schema_version: 0;
  spaces: RegistryEntry[];
  active: Record<string, string>;
  state: Record<string, SpaceState>;
  last_boundary_error: string | null;
};

export type ActiveSpaceStatus = {
  space_id: string;
  space_root: string;
  records_root: string;
  qmd: {
    collection: string;
    config_dir: string;
    cache_home: string;
  };
  sessions_dir: string;
  read_roots: string[];
  write_roots: string[];
  allowed_models: string[];
  knowledge_schema_version: string;
  packs: PackVersion[];
  compatibility: "compatible";
  qmd_freshness: SpaceState["qmd_freshness"];
  session_boundary: "validated-not-enforced";
};

export type SpaceRegistryStatus = {
  schema_version: 0;
  registered_spaces: string[];
  active_spaces: Record<string, ActiveSpaceStatus>;
  last_boundary_error: string | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key));
}

function requiredString(value: unknown, field: string, errors: string[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
    return undefined;
  }
  if (value.includes("\n") || value.includes("\r")) {
    errors.push(`${field} must be a single line`);
    return undefined;
  }
  return value;
}

function idValue(value: unknown, field: string, errors: string[]): string | undefined {
  const parsed = requiredString(value, field, errors);
  if (parsed !== undefined && !ID_PATTERN.test(parsed)) {
    errors.push(`${field} must be a kebab-case identifier`);
    return undefined;
  }
  return parsed;
}

function stringArray(value: unknown, field: string, errors: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must be a non-empty array`);
    return undefined;
  }
  const parsed: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = requiredString(value[index], `${field}[${index}]`, errors);
    if (item !== undefined) parsed.push(item);
  }
  return parsed.length === value.length ? parsed : undefined;
}

function packVersions(value: unknown, field: string, errors: string[]): PackVersion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must be a non-empty array`);
    return undefined;
  }

  const packs: PackVersion[] = [];
  const seen = new Set<string>();
  let extractCount = 0;
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!isObject(raw)) {
      errors.push(`${field}[${index}] must be an object`);
      continue;
    }
    for (const key of unknownKeys(raw, ["id", "version", "from", "extract"])) {
      errors.push(`${field}[${index}] contains unknown field ${key}`);
    }
    const id = idValue(raw.id, `${field}[${index}].id`, errors);
    const version = requiredString(raw.version, `${field}[${index}].version`, errors);
    const from = raw.from !== undefined ? requiredString(raw.from, `${field}[${index}].from`, errors) : undefined;
    let extract: boolean | undefined;
    if (raw.extract !== undefined) {
      if (typeof raw.extract !== "boolean") {
        errors.push(`${field}[${index}].extract must be a boolean`);
      } else {
        extract = raw.extract;
        if (extract) extractCount++;
      }
    }
    if (id === undefined || version === undefined) continue;
    if (seen.has(id)) {
      errors.push(`${field} contains duplicate pack ${id}`);
      continue;
    }
    seen.add(id);
    const pack: PackVersion = { id, version };
    if (from !== undefined) pack.from = from;
    if (extract !== undefined) pack.extract = extract;
    packs.push(pack);
  }
  if (extractCount > 1) {
    errors.push(`${field} has more than one pack with extract: true`);
  }
  return packs.length === value.length ? packs : undefined;
}

function parseManifest(value: unknown): Result<SpaceManifest> {
  if (!isObject(value)) return err(["space manifest must be an object"]);
  const errors: string[] = [];
  for (const key of unknownKeys(value, [
    "schema_version",
    "space_id",
    "knowledge_schema_version",
    "records_dir",
    "required_packs",
  ])) {
    errors.push(`space manifest contains unknown field ${key}`);
  }
  if (value.schema_version !== 0) errors.push("space manifest schema_version must be 0");
  const spaceId = idValue(value.space_id, "space manifest space_id", errors);
  const knowledgeSchemaVersion = requiredString(
    value.knowledge_schema_version,
    "space manifest knowledge_schema_version",
    errors,
  );
  const recordsDir = requiredString(value.records_dir, "space manifest records_dir", errors);
  if (recordsDir !== undefined) {
    const segments = recordsDir.split(/[\\/]/);
    const isWindowsPath = recordsDir.includes("\\") || /^[A-Za-z]:\//.test(recordsDir);
    if (
      isAbsolute(recordsDir) ||
      isWindowsPath ||
      recordsDir === "." ||
      segments.some((segment) => segment === ".." || segment === "")
    ) {
      errors.push("space manifest records_dir must be a relative path without parent or empty segments");
    }
  }
  const requiredPacks = packVersions(value.required_packs, "space manifest required_packs", errors);
  if (errors.length > 0 || spaceId === undefined || knowledgeSchemaVersion === undefined || recordsDir === undefined || requiredPacks === undefined) {
    return err(errors);
  }
  return ok({
    schemaVersion: 0,
    spaceId,
    knowledgeSchemaVersion,
    recordsDir,
    requiredPacks,
  });
}

function parseProviderPolicy(value: unknown, errors: string[]): ProviderPolicy | undefined {
  if (!isObject(value)) {
    errors.push("provider_policy must be an object");
    return undefined;
  }
  for (const key of unknownKeys(value, ["allowed_models", "credential_env"])) {
    errors.push(`provider_policy contains unknown field ${key}`);
  }
  const allowedModels = stringArray(value.allowed_models, "provider_policy.allowed_models", errors);
  const credentialEnv = stringArray(value.credential_env, "provider_policy.credential_env", errors);
  if (allowedModels === undefined || credentialEnv === undefined) return undefined;
  if (credentialEnv.some((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name))) {
    errors.push("provider_policy.credential_env entries must be environment variable names");
    return undefined;
  }
  return { allowedModels, credentialEnv };
}

function parseLocalBinding(value: unknown): Result<LocalBinding> {
  if (!isObject(value)) return err(["local binding must be an object"]);
  const errors: string[] = [];
  for (const key of unknownKeys(value, [
    "schema_version",
    "manifest_path",
    "qmd_config_dir",
    "qmd_cache_home",
    "qmd_collection_name",
    "sessions_dir",
    "read_roots",
    "write_roots",
    "provider_policy",
    "installed_packs",
  ])) {
    errors.push(`local binding contains unknown field ${key}`);
  }
  if (value.schema_version !== 0) errors.push("local binding schema_version must be 0");

  const manifestPath = requiredString(value.manifest_path, "manifest_path", errors);
  const qmdConfigDir = requiredString(value.qmd_config_dir, "qmd_config_dir", errors);
  const qmdCacheHome = requiredString(value.qmd_cache_home, "qmd_cache_home", errors);
  const qmdCollectionName = idValue(value.qmd_collection_name, "qmd_collection_name", errors);
  const sessionsDir = requiredString(value.sessions_dir, "sessions_dir", errors);
  const readRoots = stringArray(value.read_roots, "read_roots", errors);
  const writeRoots = stringArray(value.write_roots, "write_roots", errors);
  const providerPolicy = parseProviderPolicy(value.provider_policy, errors);
  const installedPacks = packVersions(value.installed_packs, "installed_packs", errors);

  for (const [field, pathValue] of [
    ["manifest_path", manifestPath],
    ["qmd_config_dir", qmdConfigDir],
    ["qmd_cache_home", qmdCacheHome],
    ["sessions_dir", sessionsDir],
  ] as const) {
    if (pathValue !== undefined && !isAbsolute(pathValue)) errors.push(`${field} must be an absolute path`);
  }
  for (const [field, roots] of [["read_roots", readRoots], ["write_roots", writeRoots]] as const) {
    if (roots !== undefined) {
      for (const root of roots) if (!isAbsolute(root)) errors.push(`${field} entries must be absolute paths`);
    }
  }

  if (
    errors.length > 0 ||
    manifestPath === undefined ||
    qmdConfigDir === undefined ||
    qmdCacheHome === undefined ||
    qmdCollectionName === undefined ||
    sessionsDir === undefined ||
    readRoots === undefined ||
    writeRoots === undefined ||
    providerPolicy === undefined ||
    installedPacks === undefined
  ) {
    return err(errors);
  }
  return ok({
    manifestPath,
    qmdConfigDir,
    qmdCacheHome,
    qmdCollectionName,
    sessionsDir,
    readRoots,
    writeRoots,
    providerPolicy,
    installedPacks,
  });
}

async function readJson(path: string, label: string): Promise<Result<unknown>> {
  try {
    return ok(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return err([`${label} could not be read as JSON`]);
  }
}

async function canonicalDirectory(path: string, field: string, errors: string[]): Promise<string | undefined> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) {
      errors.push(`${field} must name a directory`);
      return undefined;
    }
    return canonical;
  } catch {
    errors.push(`${field} must name an existing directory`);
    return undefined;
  }
}

function containsPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(".." + sep) && !isAbsolute(pathFromRoot));
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

async function loadEffectiveBinding(bindingPath: string): Promise<Result<ActiveSpace>> {
  const bindingJson = await readJson(bindingPath, "local binding");
  if (!bindingJson.ok) return bindingJson;
  const bindingResult = parseLocalBinding(bindingJson.value);
  if (!bindingResult.ok) return bindingResult;
  const binding = bindingResult.value;

  const manifestJson = await readJson(binding.manifestPath, "space manifest");
  if (!manifestJson.ok) return manifestJson;
  const manifestResult = parseManifest(manifestJson.value);
  if (!manifestResult.ok) return manifestResult;
  const manifest = manifestResult.value;

  const errors: string[] = [];
  let canonicalBindingPath: string | undefined;
  try {
    canonicalBindingPath = await realpath(bindingPath);
    if (!(await stat(canonicalBindingPath)).isFile()) errors.push("binding path must name a file");
  } catch {
    errors.push("binding path must name an existing file");
  }
  let manifestPath: string | undefined;
  try {
    manifestPath = await realpath(binding.manifestPath);
    if (!(await stat(manifestPath)).isFile()) errors.push("manifest_path must name a file");
  } catch {
    errors.push("manifest_path must name an existing file");
  }

  const spaceRoot = manifestPath === undefined ? undefined : await canonicalDirectory(dirname(manifestPath), "space root", errors);
  const recordsRoot = spaceRoot === undefined
    ? undefined
    : await canonicalDirectory(resolve(spaceRoot, manifest.recordsDir), "records_dir", errors);
  const qmdConfigDir = await canonicalDirectory(binding.qmdConfigDir, "qmd_config_dir", errors);
  const qmdCacheHome = await canonicalDirectory(binding.qmdCacheHome, "qmd_cache_home", errors);
  const sessionsDir = await canonicalDirectory(binding.sessionsDir, "sessions_dir", errors);

  const readRoots: string[] = [];
  for (const [index, readRoot] of binding.readRoots.entries()) {
    const root = await canonicalDirectory(readRoot, `read_roots[${index}]`, errors);
    if (root !== undefined) readRoots.push(root);
  }
  const writeRoots: string[] = [];
  for (const [index, writeRoot] of binding.writeRoots.entries()) {
    const root = await canonicalDirectory(writeRoot, `write_roots[${index}]`, errors);
    if (root !== undefined) writeRoots.push(root);
  }

  if (qmdConfigDir !== undefined && await isDefaultQmdConfigDir(qmdConfigDir)) {
    errors.push("qmd_config_dir must not be the user's default qmd configuration directory");
  }
  if (qmdCacheHome !== undefined && await isDefaultQmdCacheHome(qmdCacheHome)) {
    errors.push("qmd_cache_home must not be the user's default qmd cache home");
  }
  if (recordsRoot !== undefined && !readRoots.some((root) => containsPath(root, recordsRoot))) {
    errors.push("read_roots must authorize records_dir");
  }
  if (recordsRoot !== undefined && !writeRoots.some((root) => containsPath(root, recordsRoot))) {
    errors.push("write_roots must authorize records_dir");
  }
  if (spaceRoot !== undefined && readRoots.some((root) => !containsPath(spaceRoot, root))) {
    errors.push("read_roots must stay within the portable space root");
  }
  if (spaceRoot !== undefined && writeRoots.some((root) => !containsPath(spaceRoot, root))) {
    errors.push("write_roots must stay within the portable space root");
  }
  if (!SUPPORTED_KNOWLEDGE_SCHEMA_VERSIONS.has(manifest.knowledgeSchemaVersion)) {
    errors.push(`unsupported knowledge schema version ${manifest.knowledgeSchemaVersion}`);
  }

  const installedById = new Map(binding.installedPacks.map((pack) => [pack.id, pack.version]));
  for (const required of manifest.requiredPacks) {
    const installedVersion = installedById.get(required.id);
    if (installedVersion !== required.version) {
      errors.push(`required pack ${required.id} version ${required.version} is not installed at that version`);
    }
  }

  if (
    errors.length > 0 ||
    canonicalBindingPath === undefined ||
    manifestPath === undefined ||
    spaceRoot === undefined ||
    recordsRoot === undefined ||
    qmdConfigDir === undefined ||
    qmdCacheHome === undefined ||
    sessionsDir === undefined
  ) {
    return err(errors);
  }

  const bindingPackIndex = new Map<string, PackVersion>();
  for (const bp of binding.installedPacks) bindingPackIndex.set(bp.id, bp);
  const packs: PackVersion[] = manifest.requiredPacks.map((pack) => {
    const bp = bindingPackIndex.get(pack.id);
    if (bp === undefined) return { ...pack };
    const merged: PackVersion = { id: pack.id, version: pack.version };
    if (bp.from !== undefined) merged.from = bp.from;
    if (bp.extract !== undefined) merged.extract = bp.extract;
    return merged;
  });

  return ok({
    spaceId: manifest.spaceId,
    spaceRoot,
    bindingPath: canonicalBindingPath,
    manifestPath,
    recordsRoot,
    qmdConfigDir,
    qmdCacheHome,
    qmdCollectionName: binding.qmdCollectionName,
    sessionsDir,
    readRoots,
    writeRoots,
    allowedModels: [...binding.providerPolicy.allowedModels],
    credentialEnv: [...binding.providerPolicy.credentialEnv],
    knowledgeSchemaVersion: manifest.knowledgeSchemaVersion,
    packs,
  });
}

function emptyRegistry(): RegistryDocument {
  return { schema_version: 0, spaces: [], active: {}, state: {}, last_boundary_error: null };
}

function parseRegisteredBoundary(
  value: unknown,
  field: string,
  errors: string[],
): RegisteredBoundary | undefined {
  if (!isObject(value)) {
    errors.push(`${field} must be an object`);
    return undefined;
  }
  for (const key of unknownKeys(value, [
    "space_root",
    "records_root",
    "qmd_config_dir",
    "qmd_cache_home",
    "qmd_collection_name",
    "sessions_dir",
  ])) {
    errors.push(`${field} contains unknown field ${key}`);
  }
  const spaceRoot = requiredString(value.space_root, `${field}.space_root`, errors);
  const recordsRoot = requiredString(value.records_root, `${field}.records_root`, errors);
  const qmdConfigDir = requiredString(value.qmd_config_dir, `${field}.qmd_config_dir`, errors);
  const qmdCacheHome = requiredString(value.qmd_cache_home, `${field}.qmd_cache_home`, errors);
  const qmdCollectionName = idValue(value.qmd_collection_name, `${field}.qmd_collection_name`, errors);
  const sessionsDir = requiredString(value.sessions_dir, `${field}.sessions_dir`, errors);

  for (const [pathField, pathValue] of [
    ["space_root", spaceRoot],
    ["records_root", recordsRoot],
    ["qmd_config_dir", qmdConfigDir],
    ["qmd_cache_home", qmdCacheHome],
    ["sessions_dir", sessionsDir],
  ] as const) {
    if (pathValue !== undefined && !isAbsolute(pathValue)) errors.push(`${field}.${pathField} must be absolute`);
  }
  if (
    spaceRoot === undefined ||
    recordsRoot === undefined ||
    qmdConfigDir === undefined ||
    qmdCacheHome === undefined ||
    qmdCollectionName === undefined ||
    sessionsDir === undefined ||
    !isAbsolute(spaceRoot) ||
    !isAbsolute(recordsRoot) ||
    !isAbsolute(qmdConfigDir) ||
    !isAbsolute(qmdCacheHome) ||
    !isAbsolute(sessionsDir)
  ) {
    return undefined;
  }
  return {
    space_root: spaceRoot,
    records_root: recordsRoot,
    qmd_config_dir: qmdConfigDir,
    qmd_cache_home: qmdCacheHome,
    qmd_collection_name: qmdCollectionName,
    sessions_dir: sessionsDir,
  };
}

function parseRegistry(value: unknown): Result<RegistryDocument> {
  if (!isObject(value)) return err(["space registry must be an object"]);
  const errors: string[] = [];
  for (const key of unknownKeys(value, ["schema_version", "spaces", "active", "state", "last_boundary_error"])) {
    errors.push(`space registry contains unknown field ${key}`);
  }
  if (value.schema_version !== 0) errors.push("space registry schema_version must be 0");

  const spaces: RegistryEntry[] = [];
  if (!Array.isArray(value.spaces)) {
    errors.push("space registry spaces must be an array");
  } else {
    for (let index = 0; index < value.spaces.length; index++) {
      const item = value.spaces[index];
      if (!isObject(item)) {
        errors.push(`space registry spaces[${index}] must be an object`);
        continue;
      }
      for (const key of unknownKeys(item, ["space_id", "binding_path", "binding_hash", "boundary"])) {
        errors.push(`space registry spaces[${index}] contains unknown field ${key}`);
      }
      const spaceId = idValue(item.space_id, `space registry spaces[${index}].space_id`, errors);
      const bindingPath = requiredString(item.binding_path, `space registry spaces[${index}].binding_path`, errors);
      const bindingHash = requiredString(item.binding_hash, `space registry spaces[${index}].binding_hash`, errors);
      const boundary = parseRegisteredBoundary(item.boundary, `space registry spaces[${index}].boundary`, errors);
      if (bindingPath !== undefined && !isAbsolute(bindingPath)) {
        errors.push(`space registry spaces[${index}].binding_path must be absolute`);
      }
      if (bindingHash !== undefined && !/^[0-9a-f]{64}$/.test(bindingHash)) {
        errors.push(`space registry spaces[${index}].binding_hash must be a SHA-256 value`);
      }
      if (
        spaceId !== undefined &&
        bindingPath !== undefined &&
        isAbsolute(bindingPath) &&
        bindingHash !== undefined &&
        boundary !== undefined &&
        /^[0-9a-f]{64}$/.test(bindingHash)
      ) {
        spaces.push({ space_id: spaceId, binding_path: bindingPath, binding_hash: bindingHash, boundary });
      }
    }
  }

  const active: Record<string, string> = {};
  if (!isObject(value.active)) {
    errors.push("space registry active must be an object mapping host sessions to spaces");
  } else {
    for (const [hostSessionId, rawSpaceId] of Object.entries(value.active)) {
      if (!SESSION_ID_PATTERN.test(hostSessionId)) {
        errors.push(`space registry active contains invalid host session id ${hostSessionId}`);
        continue;
      }
      const spaceId = idValue(rawSpaceId, `space registry active.${hostSessionId}`, errors);
      if (spaceId !== undefined) active[hostSessionId] = spaceId;
    }
  }

  const state: Record<string, SpaceState> = {};
  if (!isObject(value.state)) {
    errors.push("space registry state must be an object");
  } else {
    for (const [spaceId, rawState] of Object.entries(value.state)) {
      if (!ID_PATTERN.test(spaceId) || !isObject(rawState)) {
        errors.push("space registry contains invalid state entry");
        continue;
      }
      for (const key of unknownKeys(rawState, ["qmd_freshness"])) {
        errors.push(`space registry state for ${spaceId} contains unknown field ${key}`);
      }
      const freshness = rawState.qmd_freshness;
      if (freshness !== "unknown" && freshness !== "fresh" && freshness !== "index-stale") {
        errors.push(`space registry state for ${spaceId} has invalid qmd_freshness`);
      } else {
        state[spaceId] = { qmd_freshness: freshness };
      }
    }
  }

  let lastBoundaryError: string | null = null;
  if (value.last_boundary_error !== null) {
    lastBoundaryError = requiredString(value.last_boundary_error, "space registry last_boundary_error", errors) ?? null;
  }
  if (errors.length > 0) return err(errors);
  return ok({ schema_version: 0, spaces, active, state, last_boundary_error: lastBoundaryError });
}

async function loadRegistry(registryPath: string, missingIsEmpty: boolean): Promise<Result<RegistryDocument>> {
  try {
    const parsed = JSON.parse(await readFile(registryPath, "utf8"));
    return parseRegistry(parsed);
  } catch (error) {
    if (missingIsEmpty && isObject(error) && error.code === "ENOENT") return ok(emptyRegistry());
    return err(["space registry could not be read as JSON"]);
  }
}

async function saveRegistry(registryPath: string, registry: RegistryDocument): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  await atomicWriteFile(registryPath, JSON.stringify(registry, null, 2) + "\n");
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function parseRegistryLockOwner(value: unknown): Result<RegistryLockOwner> {
  if (!isObject(value)) return err(["registry lock owner metadata must be an object"]);
  const errors: string[] = [];
  for (const key of unknownKeys(value, ["schema_version", "pid", "hostname", "token", "purpose"])) {
    errors.push(`registry lock owner metadata contains unknown field ${key}`);
  }
  if (value.schema_version !== 0) errors.push("registry lock owner schema_version must be 0");
  if (!Number.isSafeInteger(value.pid) || typeof value.pid !== "number" || value.pid <= 0) {
    errors.push("registry lock owner pid must be a positive integer");
  }
  const ownerHostname = requiredString(value.hostname, "registry lock owner hostname", errors);
  const token = requiredString(value.token, "registry lock owner token", errors);
  let purpose: "recovery" | undefined;
  if (value.purpose !== undefined) {
    if (value.purpose !== "recovery") errors.push("registry lock owner purpose must be recovery when present");
    else purpose = "recovery";
  }
  if (
    errors.length > 0 ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    ownerHostname === undefined ||
    token === undefined
  ) {
    return err(errors);
  }
  if (purpose === "recovery") {
    return ok({ schema_version: 0, pid: value.pid, hostname: ownerHostname, token, purpose });
  }
  return ok({ schema_version: 0, pid: value.pid, hostname: ownerHostname, token });
}

async function readRegistryLockOwner(lockPath: string): Promise<Result<RegistryLockOwner>> {
  try {
    return parseRegistryLockOwner(JSON.parse(await readFile(lockPath, "utf8")));
  } catch {
    return err(["registry lock is held but its owner metadata cannot be validated"]);
  }
}

function processState(pid: number): "live" | "absent" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "absent" : "unknown";
  }
}

async function clearStaleRecoveryMarker(recoveryPath: string): Promise<Result<void>> {
  try {
    await stat(recoveryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return ok(undefined);
    return err(["registry lock recovery marker could not be inspected"]);
  }

  const existing = await readRegistryLockOwner(recoveryPath);
  if (!existing.ok || existing.value.purpose !== "recovery") {
    return err(["registry lock recovery owner metadata cannot be validated"]);
  }
  if (existing.value.hostname !== hostname()) {
    return err([`registry lock recovery is held by pid ${existing.value.pid} on a host whose liveness cannot be validated`]);
  }
  const state = processState(existing.value.pid);
  if (state === "live") return err([`registry lock recovery is held by live pid ${existing.value.pid}`]);
  if (state === "unknown") {
    return err([`registry lock recovery is held by pid ${existing.value.pid} whose liveness cannot be validated`]);
  }
  try {
    await unlink(recoveryPath);
    return ok(undefined);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return ok(undefined);
    return err(["registry lock recovery marker changed while stale-owner recovery was being validated"]);
  }
}

async function installExclusiveOwnerMetadata(
  ownerPath: string,
  owner: RegistryLockOwner,
): Promise<Result<boolean>> {
  const candidatePath = `${ownerPath}.candidate-${owner.pid}-${owner.token}`;
  try {
    await writeFile(candidatePath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await link(candidatePath, ownerPath);
      return ok(true);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return ok(false);
      return err(["registry lock owner metadata could not be installed"]);
    }
  } catch (error) {
    return err(["registry lock owner metadata could not be prepared"]);
  } finally {
    await unlink(candidatePath).catch(() => {});
  }
}

async function recoverProvenStaleLock(
  lockPath: string,
  recoveryPath: string,
  expectedOwner: RegistryLockOwner,
): Promise<Result<void>> {
  const recoveryOwner: RegistryLockOwner = {
    schema_version: 0,
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    purpose: "recovery",
  };
  const installed = await installExclusiveOwnerMetadata(recoveryPath, recoveryOwner);
  if (!installed.ok) return installed;
  if (!installed.value) return err(["registry lock recovery is already in progress"]);

  try {
    const current = await readRegistryLockOwner(lockPath);
    if (!current.ok) return current;
    if (
      current.value.pid !== expectedOwner.pid ||
      current.value.hostname !== expectedOwner.hostname ||
      current.value.token !== expectedOwner.token
    ) {
      return err(["registry lock changed while stale-owner recovery was being validated"]);
    }
    const state = processState(current.value.pid);
    if (state === "live") return err([`registry lock is held by live pid ${current.value.pid}`]);
    if (state === "unknown") {
      return err([`registry lock is held by pid ${current.value.pid} whose liveness cannot be validated`]);
    }
    await unlink(lockPath);
    return ok(undefined);
  } catch {
    return err(["registry lock changed while stale-owner recovery was being validated"]);
  } finally {
    await unlink(recoveryPath).catch(() => {});
  }
}

async function acquireRegistryLock(registryPath: string): Promise<Result<RegistryLockOwner>> {
  const lockPath = `${registryPath}.lock`;
  const recoveryPath = `${lockPath}.recovery`;
  await mkdir(dirname(registryPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    const clearedRecovery = await clearStaleRecoveryMarker(recoveryPath);
    if (!clearedRecovery.ok) return clearedRecovery;
    const owner: RegistryLockOwner = {
      schema_version: 0,
      pid: process.pid,
      hostname: hostname(),
      token: randomUUID(),
    };
    const candidatePath = `${lockPath}.candidate-${owner.pid}-${owner.token}`;
    try {
      await writeFile(candidatePath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await link(candidatePath, lockPath);
      return ok(owner);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        return err(["registry lock could not be acquired"]);
      }
    } finally {
      await unlink(candidatePath).catch(() => {});
    }

    const existing = await readRegistryLockOwner(lockPath);
    if (!existing.ok) return existing;
    if (existing.value.hostname !== hostname()) {
      return err([`registry lock is held by pid ${existing.value.pid} on a host whose liveness cannot be validated`]);
    }
    const state = processState(existing.value.pid);
    if (state === "live") return err([`registry lock is held by live pid ${existing.value.pid}`]);
    if (state === "unknown") {
      return err([`registry lock is held by pid ${existing.value.pid} whose liveness cannot be validated`]);
    }
    const recovered = await recoverProvenStaleLock(lockPath, recoveryPath, existing.value);
    if (!recovered.ok) return recovered;
  }
  return err(["registry lock could not be acquired after recovering its proven-absent owner"]);
}

async function releaseRegistryLock(registryPath: string, owner: RegistryLockOwner): Promise<Result<void>> {
  const lockPath = `${registryPath}.lock`;
  const current = await readRegistryLockOwner(lockPath);
  if (!current.ok) return current;
  if (current.value.token !== owner.token) {
    return err(["registry lock ownership changed before release"]);
  }
  try {
    await unlink(lockPath);
    return ok(undefined);
  } catch {
    return err(["registry lock could not be released"]);
  }
}

async function withRegistryLock<T>(
  registryPath: string,
  operation: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const acquired = await acquireRegistryLock(registryPath);
  if (!acquired.ok) return acquired;
  let outcome: Result<T>;
  try {
    outcome = await operation();
  } catch {
    outcome = err(["registry mutation failed while holding the registry lock"]);
  }
  const released = await releaseRegistryLock(registryPath, acquired.value);
  if (!released.ok) return released;
  return outcome;
}

function bindingHash(space: ActiveSpace): string {
  // Integrity covers the effective boundary and provider policy, not JSON
  // formatting or required-pack metadata. Compatibility is revalidated on
  // every load, so a compatible pack upgrade can evolve without weakening
  // redirect detection.
  const integrityUnit = {
    space_id: space.spaceId,
    space_root: space.spaceRoot,
    manifest_path: space.manifestPath,
    records_root: space.recordsRoot,
    qmd_config_dir: space.qmdConfigDir,
    qmd_cache_home: space.qmdCacheHome,
    qmd_collection_name: space.qmdCollectionName,
    sessions_dir: space.sessionsDir,
    read_roots: [...space.readRoots].sort(),
    write_roots: [...space.writeRoots].sort(),
    allowed_models: [...space.allowedModels].sort(),
    credential_env: [...space.credentialEnv].sort(),
    knowledge_schema_version: space.knowledgeSchemaVersion,
  };
  return createHash("sha256").update(JSON.stringify(integrityUnit)).digest("hex");
}

function registeredBoundary(space: ActiveSpace): RegisteredBoundary {
  return {
    space_root: space.spaceRoot,
    records_root: space.recordsRoot,
    qmd_config_dir: space.qmdConfigDir,
    qmd_cache_home: space.qmdCacheHome,
    qmd_collection_name: space.qmdCollectionName,
    sessions_dir: space.sessionsDir,
  };
}

async function loadRegisteredSpace(entry: RegistryEntry): Promise<Result<ActiveSpace>> {
  const effective = await loadEffectiveBinding(entry.binding_path);
  if (!effective.ok) return effective;
  if (effective.value.spaceId !== entry.space_id) {
    return err([`registered binding identity changed since registration for ${entry.space_id}`]);
  }
  const currentHash = bindingHash(effective.value);
  if (currentHash !== entry.binding_hash) {
    return err([`registered binding or manifest changed since registration for ${entry.space_id}`]);
  }
  return effective;
}

function registrationCollision(candidate: ActiveSpace, existing: RegisteredBoundary): string | undefined {
  if (candidate.spaceRoot === existing.space_root) return "space root is already registered";
  if (pathsOverlap(candidate.spaceRoot, existing.space_root)) return "space root overlaps another registered space root";
  if (candidate.recordsRoot === existing.records_root) return "records_dir is already registered";
  if (candidate.qmdConfigDir === existing.qmd_config_dir) return "qmd_config_dir is already used by another space";
  if (pathsOverlap(candidate.qmdConfigDir, existing.qmd_config_dir)) return "qmd_config_dir overlaps another space";
  if (candidate.qmdCacheHome === existing.qmd_cache_home) return "qmd_cache_home is already used by another space";
  if (pathsOverlap(candidate.qmdCacheHome, existing.qmd_cache_home)) return "qmd_cache_home overlaps another space";
  if (candidate.qmdCollectionName === existing.qmd_collection_name) return "qmd_collection_name is already used by another space";
  if (candidate.sessionsDir === existing.sessions_dir) return "sessions_dir is already used by another space";
  if (pathsOverlap(candidate.sessionsDir, existing.sessions_dir)) return "sessions_dir overlaps another space";
  return undefined;
}

export async function registerSpace(registryPath: string, bindingPath: string): Promise<Result<ActiveSpaceStatus>> {
  if (!isAbsolute(registryPath)) return err(["space registry path must be absolute"]);
  if (!isAbsolute(bindingPath)) return err(["local binding path must be absolute"]);

  const candidate = await loadEffectiveBinding(bindingPath);
  if (!candidate.ok) return candidate;
  return withRegistryLock(registryPath, async () => {
    const registryResult = await loadRegistry(registryPath, true);
    if (!registryResult.ok) return registryResult;
    const registry = registryResult.value;

    for (const entry of registry.spaces) {
      if (entry.space_id === candidate.value.spaceId) continue;
      const collision = registrationCollision(candidate.value, entry.boundary);
      if (collision !== undefined) return err([collision]);
    }

    let canonicalBindingPath: string;
    try {
      canonicalBindingPath = await realpath(bindingPath);
    } catch {
      return err(["local binding path must name an existing file"]);
    }
    const nextEntry: RegistryEntry = {
      space_id: candidate.value.spaceId,
      binding_path: canonicalBindingPath,
      binding_hash: bindingHash(candidate.value),
      boundary: registeredBoundary(candidate.value),
    };
    registry.spaces = registry.spaces.filter((entry) => entry.space_id !== candidate.value.spaceId);
    registry.spaces.push(nextEntry);
    registry.spaces.sort((left, right) => left.space_id.localeCompare(right.space_id));
    registry.state[candidate.value.spaceId] = { qmd_freshness: "unknown" };
    registry.last_boundary_error = null;
    await saveRegistry(registryPath, registry);
    return ok(statusFor(candidate.value, "unknown"));
  });
}

function validSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

async function recordBoundaryError(registryPath: string, message: string): Promise<Result<void>> {
  return withRegistryLock(registryPath, async () => {
    const current = await loadRegistry(registryPath, false);
    if (!current.ok) return current;
    current.value.last_boundary_error = message;
    await saveRegistry(registryPath, current.value);
    return ok(undefined);
  });
}

export async function selectSpace(
  registryPath: string,
  spaceId: string,
  hostSessionId: string,
): Promise<Result<ActiveSpaceStatus>> {
  if (!validSessionId(hostSessionId)) return err(["host session id must use only letters, digits, dot, underscore, or hyphen"]);
  return withRegistryLock(registryPath, async () => {
    const registryResult = await loadRegistry(registryPath, false);
    if (!registryResult.ok) return registryResult;
    const registry = registryResult.value;
    const entry = registry.spaces.find((candidate) => candidate.space_id === spaceId);
    if (entry === undefined) return err([`space ${spaceId} is not registered`]);

    const selectedSpaceId = registry.active[hostSessionId];
    if (selectedSpaceId !== undefined && selectedSpaceId !== spaceId) {
      registry.last_boundary_error = "changing primary spaces requires a fresh host session identifier";
      await saveRegistry(registryPath, registry);
      return err([registry.last_boundary_error]);
    }

    const effective = await loadRegisteredSpace(entry);
    if (!effective.ok) {
      registry.last_boundary_error = "selected space binding failed validation";
      await saveRegistry(registryPath, registry);
      return effective;
    }
    const sessionPath = resolve(effective.value.sessionsDir, hostSessionId);
    const isNewSelection = selectedSpaceId === undefined;
    if (isNewSelection) {
      try {
        await mkdir(sessionPath);
      } catch (error) {
        const code = errorCode(error);
        const message = code === "EEXIST"
          ? "selecting a new primary space requires an unused host session identifier"
          : "the selected space's session directory could not be created";
        registry.last_boundary_error = message;
        await saveRegistry(registryPath, registry);
        return err([message]);
      }
    } else {
      await mkdir(sessionPath, { recursive: true });
    }
    registry.active[hostSessionId] = spaceId;
    registry.last_boundary_error = null;
    await saveRegistry(registryPath, registry);
    const freshness = registry.state[spaceId]?.qmd_freshness ?? "unknown";
    return ok(statusFor(effective.value, freshness));
  });
}

export async function resolveActiveSpace(env: EnvLike): Promise<Result<ActiveSpace>> {
  const registryPath = env.ENGRAM_BINDING_REGISTRY;
  const hostSessionId = env.ENGRAM_HOST_SESSION_ID;
  const errors: string[] = [];
  if (registryPath === undefined || registryPath.length === 0) errors.push("missing ENGRAM_BINDING_REGISTRY");
  else if (!isAbsolute(registryPath)) errors.push("ENGRAM_BINDING_REGISTRY must be an absolute path");
  if (hostSessionId === undefined || !validSessionId(hostSessionId)) errors.push("missing or invalid ENGRAM_HOST_SESSION_ID");
  if (errors.length > 0 || registryPath === undefined || hostSessionId === undefined) return err(errors);

  const registryResult = await loadRegistry(registryPath, false);
  if (!registryResult.ok) return registryResult;
  const registry = registryResult.value;
  const activeSpaceId = registry.active[hostSessionId];
  if (activeSpaceId === undefined) {
    const message = "no active space is selected for this host session";
    const recorded = await recordBoundaryError(registryPath, message);
    if (!recorded.ok) return recorded;
    return err([message]);
  }
  const entry = registry.spaces.find((candidate) => candidate.space_id === activeSpaceId);
  if (entry === undefined) return err(["active space is not registered"]);
  return loadRegisteredSpace(entry);
}

function statusFor(space: ActiveSpace, freshness: SpaceState["qmd_freshness"]): ActiveSpaceStatus {
  return {
    space_id: space.spaceId,
    space_root: space.spaceRoot,
    records_root: space.recordsRoot,
    qmd: {
      collection: space.qmdCollectionName,
      config_dir: space.qmdConfigDir,
      cache_home: space.qmdCacheHome,
    },
    sessions_dir: space.sessionsDir,
    read_roots: [...space.readRoots],
    write_roots: [...space.writeRoots],
    allowed_models: [...space.allowedModels],
    knowledge_schema_version: space.knowledgeSchemaVersion,
    packs: space.packs.map((pack) => ({ ...pack })),
    compatibility: "compatible",
    qmd_freshness: freshness,
    session_boundary: "validated-not-enforced",
  };
}

export async function inspectSpaceRegistry(registryPath: string): Promise<Result<SpaceRegistryStatus>> {
  const registryResult = await loadRegistry(registryPath, false);
  if (!registryResult.ok) return registryResult;
  const registry = registryResult.value;
  const activeSpaces: Record<string, ActiveSpaceStatus> = {};
  for (const [hostSessionId, spaceId] of Object.entries(registry.active)) {
    const entry = registry.spaces.find((candidate) => candidate.space_id === spaceId);
    if (entry === undefined) return err(["active space is not registered"]);
    const effective = await loadRegisteredSpace(entry);
    if (!effective.ok) return effective;
    const freshness = registry.state[entry.space_id]?.qmd_freshness ?? "unknown";
    activeSpaces[hostSessionId] = statusFor(effective.value, freshness);
  }
  return ok({
    schema_version: 0,
    registered_spaces: registry.spaces.map((entry) => entry.space_id),
    active_spaces: activeSpaces,
    last_boundary_error: registry.last_boundary_error,
  });
}

export async function recordQmdFreshness(
  registryPath: string,
  spaceId: string,
  freshness: "fresh" | "index-stale",
): Promise<Result<void>> {
  return withRegistryLock(registryPath, async () => {
    const registryResult = await loadRegistry(registryPath, false);
    if (!registryResult.ok) return registryResult;
    if (!registryResult.value.spaces.some((entry) => entry.space_id === spaceId)) {
      return err([`space ${spaceId} is not registered`]);
    }
    registryResult.value.state[spaceId] = { qmd_freshness: freshness };
    await saveRegistry(registryPath, registryResult.value);
    return ok(undefined);
  });
}
