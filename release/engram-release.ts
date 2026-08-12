import { constants, realpathSync } from "node:fs";
import { chmod, lstat, link, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const RELEASE_SCHEMA_VERSION = 0;
export const RELEASE_FORMAT_VERSION = 0;
export const PACKAGING_PROCEDURE_VERSION = "r0-source-ustar-v1";

export type ReleaseFileIntegrity = {
  path: string;
  byte_length: number;
  sha256: string;
  executable: boolean;
};

export type ReleaseArtifactIntegrity = {
  filename: string;
  byte_length: number;
  sha256: string;
};

type ReleasePack = {
  id: string;
  version: string;
};

type ReleaseQmdCompatibility = {
  contract: "scoped-cli";
  version: string;
};

type ReleaseEnvironmentCompatibility = {
  platform: "darwin";
  architecture: "arm64";
  node_version: string;
};

type ReleaseVerification = {
  command: string;
  outcome: "passed" | "not_applicable";
  mode: "automated" | "manual";
  artifact_sha256: string;
};

export type ReleaseManifest = {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  release_format: typeof RELEASE_FORMAT_VERSION;
  version: string;
  source_revision: string;
  packaging_procedure_version: typeof PACKAGING_PROCEDURE_VERSION;
  host_agent_compatibility: "host-neutral-cli-schema-0";
  qmd_compatibility: ReleaseQmdCompatibility;
  knowledge_schema_compatibility: ["0"];
  pack_api_compatibility: 0;
  environment_compatibility: ReleaseEnvironmentCompatibility;
  included_packs: ReleasePack[];
  files: ReleaseFileIntegrity[];
};

export type ReleaseRecord = {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  version: string;
  source_revision: string;
  packaging_procedure_version: typeof PACKAGING_PROCEDURE_VERSION;
  host_agent_compatibility: "host-neutral-cli-schema-0";
  qmd_compatibility: ReleaseQmdCompatibility;
  knowledge_schema_compatibility: ["0"];
  pack_api_compatibility: 0;
  environment_compatibility: ReleaseEnvironmentCompatibility;
  included_packs: ReleasePack[];
  included_beads: string[];
  verification_summary: ReleaseVerification[];
  known_limitations: string[];
  artifact_integrity: {
    archive: ReleaseArtifactIntegrity;
    bootstrap: ReleaseArtifactIntegrity;
  };
  published_at: string;
};

export type ReleaseErrorCode =
  | "release_manifest_invalid"
  | "release_record_invalid"
  | "release_id_invalid"
  | "host_agent_compatibility_invalid"
  | "release_path_invalid"
  | "release_path_duplicate"
  | "files_order_invalid"
  | "included_packs_order_invalid"
  | "known_limitations_invalid"
  | "verification_artifact_mismatch"
  | "release_incompatible"
  | "release_boundary_unsafe"
  | "artifact_integrity_mismatch"
  | "archive_unsafe"
  | "archive_inventory_mismatch"
  | "release_identity_mismatch"
  | "release_exists"
  | "install_lock_conflict"
  | "install_lock_owner_unverifiable"
  | "install_failed"
  | "selection_target_unknown"
  | "selection_target_linked"
  | "selection_target_invalid"
  | "selection_target_incompatible"
  | "launcher_conflict"
  | "current_absent";

export type ReleaseError = {
  code: ReleaseErrorCode;
  message: string;
  field?: string;
  detail?: string;
};

export type ReleaseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ReleaseError[] };

type ErrorList = ReleaseError[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addError(errors: ErrorList, code: ReleaseErrorCode, field: string): void {
  errors.push({ code, message: `${field} is invalid`, field });
}

function failed<T>(code: ReleaseErrorCode, field: string): ReleaseResult<T> {
  return { ok: false, errors: [{ code, message: `${field} is invalid`, field }] };
}

function hasExactKeys(raw: Record<string, unknown>, keys: readonly string[], errors: ErrorList, code: ReleaseErrorCode): void {
  const actualKeys = Object.keys(raw).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    addError(errors, code, "top_level_keys");
  }
}

function singleLineString(raw: unknown, field: string, errors: ErrorList, code: ReleaseErrorCode): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\n") || raw.includes("\r")) {
    addError(errors, code, field);
    return undefined;
  }
  return raw;
}

function nonNegativeInteger(raw: unknown, field: string, errors: ErrorList, code: ReleaseErrorCode): number | undefined {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    addError(errors, code, field);
    return undefined;
  }
  return raw;
}

function sha256(raw: unknown, field: string, errors: ErrorList, code: ReleaseErrorCode): string | undefined {
  const value = singleLineString(raw, field, errors, code);
  if (value === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/.test(value)) {
    addError(errors, code, field);
    return undefined;
  }
  return value;
}

function safeRelativePath(raw: unknown, field: string, errors: ErrorList, code: ReleaseErrorCode): string | undefined {
  const value = singleLineString(raw, field, errors, code);
  if (value === undefined) return undefined;
  const segments = value.split("/");
  if (
    isAbsolute(value) ||
    value.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    addError(errors, "release_path_invalid", field);
    return undefined;
  }
  return value;
}

function parseReleaseIdentity(raw: Record<string, unknown>, errors: ErrorList, code: ReleaseErrorCode): { version: string; source_revision: string } | undefined {
  const sourceRevision = singleLineString(raw.source_revision, "source_revision", errors, code);
  const version = singleLineString(raw.version, "version", errors, code);
  if (sourceRevision === undefined || version === undefined) return undefined;
  if (!/^[a-f0-9]{40}$/.test(sourceRevision) || version !== `r0-${sourceRevision}`) {
    addError(errors, "release_id_invalid", "version");
    return undefined;
  }
  return { version, source_revision: sourceRevision };
}

function parseQmdCompatibility(raw: unknown, errors: ErrorList, code: ReleaseErrorCode): ReleaseQmdCompatibility | undefined {
  if (!isRecord(raw)) {
    addError(errors, code, "qmd_compatibility");
    return undefined;
  }
  hasExactKeys(raw, ["contract", "version"], errors, code);
  const contract = singleLineString(raw.contract, "qmd_compatibility.contract", errors, code);
  const version = singleLineString(raw.version, "qmd_compatibility.version", errors, code);
  if (contract !== "scoped-cli") addError(errors, code, "qmd_compatibility.contract");
  if (contract !== "scoped-cli" || version === undefined) return undefined;
  return { contract, version };
}

function parseKnowledgeSchemaCompatibility(raw: unknown, errors: ErrorList, code: ReleaseErrorCode): ["0"] | undefined {
  if (!Array.isArray(raw) || raw.length !== 1 || raw[0] !== "0") {
    addError(errors, code, "knowledge_schema_compatibility");
    return undefined;
  }
  return ["0"];
}

function parseEnvironmentCompatibility(raw: unknown, errors: ErrorList, code: ReleaseErrorCode): ReleaseEnvironmentCompatibility | undefined {
  if (!isRecord(raw)) {
    addError(errors, code, "environment_compatibility");
    return undefined;
  }
  hasExactKeys(raw, ["platform", "architecture", "node_version"], errors, code);
  const platform = singleLineString(raw.platform, "environment_compatibility.platform", errors, code);
  const architecture = singleLineString(raw.architecture, "environment_compatibility.architecture", errors, code);
  const nodeVersion = singleLineString(raw.node_version, "environment_compatibility.node_version", errors, code);
  if (platform !== "darwin") addError(errors, code, "environment_compatibility.platform");
  if (architecture !== "arm64") addError(errors, code, "environment_compatibility.architecture");
  if (nodeVersion !== process.version) addError(errors, code, "environment_compatibility.node_version");
  if (platform !== "darwin" || architecture !== "arm64" || nodeVersion !== process.version) return undefined;
  return { platform, architecture, node_version: nodeVersion };
}

function parseIncludedPacks(raw: unknown, errors: ErrorList, code: ReleaseErrorCode): ReleasePack[] | undefined {
  if (!Array.isArray(raw)) {
    addError(errors, code, "included_packs");
    return undefined;
  }
  const packs: ReleasePack[] = [];
  let valid = true;
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    const field = `included_packs.${index}`;
    if (!isRecord(entry)) {
      addError(errors, code, field);
      valid = false;
      continue;
    }
    hasExactKeys(entry, ["id", "version"], errors, code);
    const id = singleLineString(entry.id, `${field}.id`, errors, code);
    const version = singleLineString(entry.version, `${field}.version`, errors, code);
    if (id === undefined || version === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      if (id !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) addError(errors, code, `${field}.id`);
      valid = false;
      continue;
    }
    packs.push({ id, version });
  }
  for (let index = 1; index < packs.length; index += 1) {
    const previous = packs[index - 1];
    const current = packs[index];
    if (previous === undefined || current === undefined) continue;
    if (previous.id >= current.id) {
      addError(errors, "included_packs_order_invalid", "included_packs");
      valid = false;
      break;
    }
  }
  return valid ? packs : undefined;
}

function parseFiles(raw: unknown, errors: ErrorList, code: ReleaseErrorCode): ReleaseFileIntegrity[] | undefined {
  if (!Array.isArray(raw)) {
    addError(errors, code, "files");
    return undefined;
  }
  const files: ReleaseFileIntegrity[] = [];
  let valid = true;
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    const field = `files.${index}`;
    if (!isRecord(entry)) {
      addError(errors, code, field);
      valid = false;
      continue;
    }
    hasExactKeys(entry, ["path", "byte_length", "sha256", "executable"], errors, code);
    const path = safeRelativePath(entry.path, `${field}.path`, errors, code);
    const byteLength = nonNegativeInteger(entry.byte_length, `${field}.byte_length`, errors, code);
    const hash = sha256(entry.sha256, `${field}.sha256`, errors, code);
    const executable = entry.executable;
    if (typeof executable !== "boolean") addError(errors, code, `${field}.executable`);
    if (path === undefined || byteLength === undefined || hash === undefined || typeof executable !== "boolean") {
      valid = false;
      continue;
    }
    if (seen.has(path)) {
      addError(errors, "release_path_duplicate", path);
      valid = false;
    }
    seen.add(path);
    files.push({ path, byte_length: byteLength, sha256: hash, executable });
  }
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];
    if (previous === undefined || current === undefined) continue;
    if (previous.path >= current.path) {
      addError(errors, "files_order_invalid", "files");
      valid = false;
      break;
    }
  }
  return valid ? files : undefined;
}

function parseArtifactIntegrity(raw: unknown, field: string, errors: ErrorList, code: ReleaseErrorCode): ReleaseArtifactIntegrity | undefined {
  if (!isRecord(raw)) {
    addError(errors, code, field);
    return undefined;
  }
  hasExactKeys(raw, ["filename", "byte_length", "sha256"], errors, code);
  const filename = safeRelativePath(raw.filename, `${field}.filename`, errors, code);
  const byteLength = nonNegativeInteger(raw.byte_length, `${field}.byte_length`, errors, code);
  const hash = sha256(raw.sha256, `${field}.sha256`, errors, code);
  if (filename === undefined || byteLength === undefined || hash === undefined) return undefined;
  return { filename, byte_length: byteLength, sha256: hash };
}

function parseStringArray(raw: unknown, field: string, errors: ErrorList, code: ReleaseErrorCode): string[] | undefined {
  if (!Array.isArray(raw)) {
    addError(errors, code, field);
    return undefined;
  }
  const values: string[] = [];
  let valid = true;
  for (let index = 0; index < raw.length; index += 1) {
    const value = singleLineString(raw[index], `${field}.${index}`, errors, code);
    if (value === undefined) {
      valid = false;
      continue;
    }
    values.push(value);
  }
  return valid ? values : undefined;
}

function parseVerificationSummary(raw: unknown, archiveHash: string | undefined, errors: ErrorList, code: ReleaseErrorCode): ReleaseVerification[] | undefined {
  if (!Array.isArray(raw)) {
    addError(errors, code, "verification_summary");
    return undefined;
  }
  const entries: ReleaseVerification[] = [];
  let valid = true;
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    const field = `verification_summary.${index}`;
    if (!isRecord(entry)) {
      addError(errors, code, field);
      valid = false;
      continue;
    }
    hasExactKeys(entry, ["command", "outcome", "mode", "artifact_sha256"], errors, code);
    const command = singleLineString(entry.command, `${field}.command`, errors, code);
    const outcome = entry.outcome;
    const mode = entry.mode;
    const artifactHash = sha256(entry.artifact_sha256, `${field}.artifact_sha256`, errors, code);
    if (outcome !== "passed" && outcome !== "not_applicable") addError(errors, code, `${field}.outcome`);
    if (mode !== "automated" && mode !== "manual") addError(errors, code, `${field}.mode`);
    if (artifactHash !== undefined && archiveHash !== undefined && artifactHash !== archiveHash) {
      addError(errors, "verification_artifact_mismatch", `${field}.artifact_sha256`);
      valid = false;
    }
    if (
      command === undefined ||
      artifactHash === undefined ||
      (outcome !== "passed" && outcome !== "not_applicable") ||
      (mode !== "automated" && mode !== "manual")
    ) {
      valid = false;
      continue;
    }
    entries.push({ command, outcome, mode, artifact_sha256: artifactHash });
  }
  return valid ? entries : undefined;
}

function parseCommon(raw: Record<string, unknown>, errors: ErrorList, code: ReleaseErrorCode): {
  identity: { version: string; source_revision: string } | undefined;
  packagingProcedureVersion: typeof PACKAGING_PROCEDURE_VERSION | undefined;
  hostAgentCompatibility: "host-neutral-cli-schema-0" | undefined;
  qmdCompatibility: ReleaseQmdCompatibility | undefined;
  knowledgeSchemaCompatibility: ["0"] | undefined;
  packApiCompatibility: 0 | undefined;
  environmentCompatibility: ReleaseEnvironmentCompatibility | undefined;
  includedPacks: ReleasePack[] | undefined;
} {
  const identity = parseReleaseIdentity(raw, errors, code);
  const packagingProcedureVersion = raw.packaging_procedure_version === PACKAGING_PROCEDURE_VERSION
    ? PACKAGING_PROCEDURE_VERSION
    : undefined;
  if (packagingProcedureVersion === undefined) addError(errors, code, "packaging_procedure_version");
  const hostAgentCompatibility = raw.host_agent_compatibility === "host-neutral-cli-schema-0"
    ? "host-neutral-cli-schema-0"
    : undefined;
  if (hostAgentCompatibility === undefined) addError(errors, "host_agent_compatibility_invalid", "host_agent_compatibility");
  const qmdCompatibility = parseQmdCompatibility(raw.qmd_compatibility, errors, code);
  const knowledgeSchemaCompatibility = parseKnowledgeSchemaCompatibility(raw.knowledge_schema_compatibility, errors, code);
  const packApiCompatibility = raw.pack_api_compatibility === 0 ? 0 : undefined;
  if (packApiCompatibility === undefined) addError(errors, code, "pack_api_compatibility");
  const environmentCompatibility = parseEnvironmentCompatibility(raw.environment_compatibility, errors, code);
  const includedPacks = parseIncludedPacks(raw.included_packs, errors, code);
  return {
    identity,
    packagingProcedureVersion,
    hostAgentCompatibility,
    qmdCompatibility,
    knowledgeSchemaCompatibility,
    packApiCompatibility,
    environmentCompatibility,
    includedPacks,
  };
}

export function parseReleaseManifest(raw: unknown): ReleaseResult<ReleaseManifest> {
  if (!isRecord(raw)) return failed("release_manifest_invalid", "release_manifest");
  const errors: ErrorList = [];
  hasExactKeys(raw, [
    "schema_version", "release_format", "version", "source_revision", "packaging_procedure_version",
    "host_agent_compatibility", "qmd_compatibility", "knowledge_schema_compatibility", "pack_api_compatibility",
    "environment_compatibility", "included_packs", "files",
  ], errors, "release_manifest_invalid");
  if (raw.schema_version !== RELEASE_SCHEMA_VERSION) addError(errors, "release_manifest_invalid", "schema_version");
  if (raw.release_format !== RELEASE_FORMAT_VERSION) addError(errors, "release_manifest_invalid", "release_format");
  const common = parseCommon(raw, errors, "release_manifest_invalid");
  const files = parseFiles(raw.files, errors, "release_manifest_invalid");
  if (
    errors.length > 0 ||
    common.identity === undefined ||
    common.packagingProcedureVersion === undefined ||
    common.hostAgentCompatibility === undefined ||
    common.qmdCompatibility === undefined ||
    common.knowledgeSchemaCompatibility === undefined ||
    common.packApiCompatibility === undefined ||
    common.environmentCompatibility === undefined ||
    common.includedPacks === undefined ||
    files === undefined
  ) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schema_version: RELEASE_SCHEMA_VERSION,
      release_format: RELEASE_FORMAT_VERSION,
      version: common.identity.version,
      source_revision: common.identity.source_revision,
      packaging_procedure_version: common.packagingProcedureVersion,
      host_agent_compatibility: common.hostAgentCompatibility,
      qmd_compatibility: common.qmdCompatibility,
      knowledge_schema_compatibility: common.knowledgeSchemaCompatibility,
      pack_api_compatibility: common.packApiCompatibility,
      environment_compatibility: common.environmentCompatibility,
      included_packs: common.includedPacks,
      files,
    },
  };
}

export function parseReleaseRecord(raw: unknown): ReleaseResult<ReleaseRecord> {
  if (!isRecord(raw)) return failed("release_record_invalid", "release_record");
  const errors: ErrorList = [];
  hasExactKeys(raw, [
    "schema_version", "version", "source_revision", "packaging_procedure_version", "host_agent_compatibility",
    "qmd_compatibility", "knowledge_schema_compatibility", "pack_api_compatibility", "environment_compatibility",
    "included_packs", "included_beads", "verification_summary", "known_limitations", "artifact_integrity", "published_at",
  ], errors, "release_record_invalid");
  if (raw.schema_version !== RELEASE_SCHEMA_VERSION) addError(errors, "release_record_invalid", "schema_version");
  const common = parseCommon(raw, errors, "release_record_invalid");
  const includedBeads = parseStringArray(raw.included_beads, "included_beads", errors, "release_record_invalid");
  const knownLimitations = parseStringArray(raw.known_limitations, "known_limitations", errors, "known_limitations_invalid");
  let archive: ReleaseArtifactIntegrity | undefined;
  let bootstrap: ReleaseArtifactIntegrity | undefined;
  if (!isRecord(raw.artifact_integrity)) {
    addError(errors, "release_record_invalid", "artifact_integrity");
  } else {
    hasExactKeys(raw.artifact_integrity, ["archive", "bootstrap"], errors, "release_record_invalid");
    archive = parseArtifactIntegrity(raw.artifact_integrity.archive, "artifact_integrity.archive", errors, "release_record_invalid");
    bootstrap = parseArtifactIntegrity(raw.artifact_integrity.bootstrap, "artifact_integrity.bootstrap", errors, "release_record_invalid");
  }
  const verificationSummary = parseVerificationSummary(raw.verification_summary, archive?.sha256, errors, "release_record_invalid");
  const publishedAt = singleLineString(raw.published_at, "published_at", errors, "release_record_invalid");
  if (publishedAt !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(publishedAt)) {
    addError(errors, "release_record_invalid", "published_at");
  }
  if (
    errors.length > 0 ||
    common.identity === undefined ||
    common.packagingProcedureVersion === undefined ||
    common.hostAgentCompatibility === undefined ||
    common.qmdCompatibility === undefined ||
    common.knowledgeSchemaCompatibility === undefined ||
    common.packApiCompatibility === undefined ||
    common.environmentCompatibility === undefined ||
    common.includedPacks === undefined ||
    includedBeads === undefined ||
    verificationSummary === undefined ||
    knownLimitations === undefined ||
    archive === undefined ||
    bootstrap === undefined ||
    publishedAt === undefined
  ) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schema_version: RELEASE_SCHEMA_VERSION,
      version: common.identity.version,
      source_revision: common.identity.source_revision,
      packaging_procedure_version: common.packagingProcedureVersion,
      host_agent_compatibility: common.hostAgentCompatibility,
      qmd_compatibility: common.qmdCompatibility,
      knowledge_schema_compatibility: common.knowledgeSchemaCompatibility,
      pack_api_compatibility: common.packApiCompatibility,
      environment_compatibility: common.environmentCompatibility,
      included_packs: common.includedPacks,
      included_beads: includedBeads,
      verification_summary: verificationSummary,
      known_limitations: knownLimitations,
      artifact_integrity: { archive, bootstrap },
      published_at: publishedAt,
    },
  };
}

export async function readReleaseManifest(path: string): Promise<ReleaseResult<ReleaseManifest>> {
  try {
    return parseReleaseManifest(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return failed("release_manifest_invalid", "release_manifest");
  }
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical_release_json is invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  throw new TypeError("canonical_release_json is invalid");
}

export function canonicalReleaseJson(value: unknown): string {
  return `${canonicalValue(value)}\n`;
}

export type ReleaseManagerHooks = {
  afterExistingOwnerRead?: () => Promise<void> | void;
  afterLaunchersInstalled?: () => Promise<void> | void;
  beforeSelectionRename?: () => Promise<void> | void;
};

export type ReleaseManagerOptions = {
  releaseHome?: string;
  binDir?: string;
  executablePath?: string;
  hooks?: ReleaseManagerHooks;
  manifestPath?: string;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

type ArchiveEntry = { path: string; bytes: Buffer; mode: number; directory: boolean };
type InspectedArchive = { manifest: ReleaseManifest; entries: ArchiveEntry[] };
type ReleasePaths = { home: string; releases: string };
type LockOwner = { schema_version: 0; pid: number; hostname: string; token: string; purpose?: "recovery" };
type InstallLock = { release: () => Promise<void> };
type InstalledLauncher = { path: string; ino: number; dev: number; content: string };

function managerFailure<T>(code: ReleaseErrorCode, message: string, field?: string, detail?: string): ReleaseResult<T> {
  return { ok: false, errors: [{ code, message, ...(field === undefined ? {} : { field }), ...(detail === undefined ? {} : { detail }) }] };
}

function managerErrorMessage(code: ReleaseErrorCode): string {
  const messages: Record<ReleaseErrorCode, string> = {
    release_manifest_invalid: "release manifest is invalid",
    release_record_invalid: "release record is invalid",
    release_id_invalid: "release identifier is invalid",
    host_agent_compatibility_invalid: "release compatibility is invalid",
    release_path_invalid: "release path is invalid",
    release_path_duplicate: "release path is duplicated",
    files_order_invalid: "release file order is invalid",
    included_packs_order_invalid: "release pack order is invalid",
    known_limitations_invalid: "release limitations are invalid",
    verification_artifact_mismatch: "release verification is invalid",
    release_incompatible: "release is incompatible with this host",
    release_boundary_unsafe: "release filesystem boundary is unsafe",
    artifact_integrity_mismatch: "release artifact integrity does not match",
    archive_unsafe: "release archive is unsafe",
    archive_inventory_mismatch: "release archive inventory does not match",
    release_identity_mismatch: "release identity does not match",
    release_exists: "release already exists",
    install_lock_conflict: "another release installation is active",
    install_lock_owner_unverifiable: "release installation lock owner cannot be verified",
    install_failed: "release installation failed",
    selection_target_unknown: "selected release does not exist",
    selection_target_linked: "selected release is linked",
    selection_target_invalid: "selected release is invalid",
    selection_target_incompatible: "selected release is incompatible",
    launcher_conflict: "stable launcher conflicts with an existing file",
    current_absent: "current release selection is invalid",
  };
  return messages[code];
}

function managerFailed<T>(code: ReleaseErrorCode, field?: string): ReleaseResult<T> {
  return managerFailure(code, managerErrorMessage(code), field);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isDirectChild(parent: string, child: string): boolean {
  return dirname(child) === parent && basename(child).length > 0;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function safeReleaseBoundary(parent: string, child: string, directory: boolean, symbolicLink: boolean): boolean {
  if (!directory || symbolicLink) return false;
  return isDirectChild(parent, child);
}

function safeArchivePath(path: string): boolean {
  return path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part.length === 0 || part === "." || part === "..");
}

function parentPaths(path: string): string[] {
  const parts = path.split("/");
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index++) parents.push(parts.slice(0, index).join("/"));
  return parents;
}

function textField(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  const text = raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
  if (text.includes("\0")) throw new Error("embedded null");
  return text;
}

function octalField(header: Buffer, offset: number, length: number): number {
  const text = textField(header, offset, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error("invalid octal field");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid octal value");
  return value;
}

function validChecksum(header: Buffer): boolean {
  const expected = octalField(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < 512; index++) actual += index >= 148 && index < 156 ? 32 : header[index] ?? 0;
  return actual === expected;
}

function zeroBlock(bytes: Buffer, offset: number): boolean {
  for (let index = offset; index < offset + 512; index++) if ((bytes[index] ?? 0) !== 0) return false;
  return true;
}

function archiveResultError<T>(): ReleaseResult<T> {
  return managerFailed("archive_unsafe");
}

export async function inspectArchive(input: string | Buffer): Promise<ReleaseResult<InspectedArchive>> {
  let bytes: Buffer;
  try {
    bytes = typeof input === "string" ? await readFile(input) : input;
    bytes = gunzipSync(bytes);
  } catch {
    return archiveResultError();
  }
  try {
    const entries: ArchiveEntry[] = [];
    const names = new Set<string>();
    let offset = 0;
    while (offset + 1024 <= bytes.length && !zeroBlock(bytes, offset)) {
      const header = bytes.subarray(offset, offset + 512);
      if (textField(header, 257, 6) !== "ustar" || !validChecksum(header)) throw new Error("invalid header");
      const name = textField(header, 0, 100);
      const prefix = textField(header, 345, 155);
      const pathName = prefix.length === 0 ? name : `${prefix}/${name}`;
      const type = header[156] ?? 0;
      if (type !== 0 && type !== 48 && type !== 53) throw new Error("unsupported entry type");
      const directory = type === 53;
      if (!safeArchivePath(pathName) || names.has(pathName)) throw new Error("unsafe path");
      const byteLength = octalField(header, 124, 12);
      const dataStart = offset + 512;
      const paddedLength = Math.ceil(byteLength / 512) * 512;
      if (dataStart + paddedLength > bytes.length || (directory && byteLength !== 0)) throw new Error("truncated entry");
      names.add(pathName);
      entries.push({
        path: pathName,
        bytes: Buffer.from(bytes.subarray(dataStart, dataStart + byteLength)),
        mode: octalField(header, 100, 8),
        directory,
      });
      offset = dataStart + paddedLength;
    }
    if (offset + 1024 !== bytes.length || !zeroBlock(bytes, offset) || !zeroBlock(bytes, offset + 512)) throw new Error("invalid trailer");
    const manifestEntry = entries.find((entry) => entry.path === "release-manifest.json" && !entry.directory);
    if (manifestEntry === undefined) return managerFailed("archive_inventory_mismatch");
    const parsedManifest = parseReleaseManifest(JSON.parse(manifestEntry.bytes.toString("utf8")));
    if (!parsedManifest.ok || manifestEntry.bytes.toString("utf8") !== canonicalReleaseJson(parsedManifest.value)) {
      return managerFailed("archive_inventory_mismatch");
    }
    const files = entries.filter((entry) => !entry.directory);
    const expected = new Map(parsedManifest.value.files.map((file) => [file.path, file]));
    if (files.length !== expected.size + 1) return managerFailed("archive_inventory_mismatch");
    for (const entry of files) {
      if (entry.path === "release-manifest.json") {
        if (entry.mode !== 0o644) return managerFailed("archive_inventory_mismatch");
        continue;
      }
      const file = expected.get(entry.path);
      const expectedMode = file?.executable ? 0o755 : 0o644;
      if (file === undefined || entry.mode !== expectedMode || file.byte_length !== entry.bytes.length || file.sha256 !== sha256Bytes(entry.bytes)) {
        return managerFailed("archive_inventory_mismatch");
      }
    }
    const expectedDirectories = new Set(files.flatMap((entry) => parentPaths(entry.path)));
    const directories = entries.filter((entry) => entry.directory);
    if (
      directories.length !== expectedDirectories.size ||
      directories.some((entry) => !expectedDirectories.has(entry.path) || entry.mode !== 0o755)
    ) return managerFailed("archive_inventory_mismatch");
    return { ok: true, value: { manifest: parsedManifest.value, entries } };
  } catch {
    return archiveResultError();
  }
}

async function createSafeDirectory(path: string, mode: number): Promise<void> {
  const missing: string[] = [];
  let cursor = path;
  for (;;) {
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("linked boundary");
      cursor = await realpath(cursor);
      break;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("missing root");
      cursor = parent;
    }
  }
  while (missing.length > 0) {
    const next = missing.pop();
    if (next === undefined) throw new Error("missing directory");
    await mkdir(next, { mode });
    const stat = await lstat(next);
    const canonicalNext = await realpath(next);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isDirectChild(cursor, canonicalNext)) throw new Error("linked boundary");
    cursor = canonicalNext;
  }
}

async function physicalPaths(options: ReleaseManagerOptions, create: boolean): Promise<ReleaseResult<ReleasePaths>> {
  const home = resolve(options.releaseHome ?? process.env.ENGRAM_RELEASE_HOME ?? join(homedir(), ".local", "share", "engram"));
  const releases = join(home, "releases");
  try {
    if (create) {
      // Prevalidate any already-existing requested root before creating a
      // descendant beneath it: a linked/outside root must be refused before
      // `<outside>/releases` (or any other descendant) is ever written, and
      // an already-existing accepted root is never re-created.
      const existingHome = await lstat(home).catch((error) => { if (isNotFound(error)) return undefined; throw error; });
      if (existingHome === undefined) {
        await createSafeDirectory(home, 0o755);
      } else if (!safeReleaseBoundary(await realpath(dirname(home)), await realpath(home), existingHome.isDirectory(), existingHome.isSymbolicLink())) {
        return managerFailed("release_boundary_unsafe");
      }
      const existingReleases = await lstat(releases).catch((error) => { if (isNotFound(error)) return undefined; throw error; });
      if (existingReleases === undefined) {
        await createSafeDirectory(releases, 0o755);
      } else if (!safeReleaseBoundary(await realpath(home), await realpath(releases), existingReleases.isDirectory(), existingReleases.isSymbolicLink())) {
        return managerFailed("release_boundary_unsafe");
      }
    }
    const homeStat = await lstat(home);
    const canonicalHome = await realpath(home);
    const canonicalParent = await realpath(dirname(home));
    if (!safeReleaseBoundary(canonicalParent, canonicalHome, homeStat.isDirectory(), homeStat.isSymbolicLink())) {
      return managerFailed("release_boundary_unsafe");
    }
    let releasesStat;
    try {
      releasesStat = await lstat(releases);
    } catch (error) {
      if (isNotFound(error) && !create) return managerFailed("selection_target_unknown");
      return managerFailed("release_boundary_unsafe");
    }
    const canonicalReleases = await realpath(releases);
    if (!safeReleaseBoundary(canonicalHome, canonicalReleases, releasesStat.isDirectory(), releasesStat.isSymbolicLink())) {
      return managerFailed("release_boundary_unsafe");
    }
    return { ok: true, value: { home: canonicalHome, releases: canonicalReleases } };
  } catch (error) {
    if (!create && isNotFound(error)) return managerFailed("selection_target_unknown");
    return managerFailed("release_boundary_unsafe");
  }
}

function compatible(manifest: ReleaseManifest): boolean {
  return manifest.environment_compatibility.platform === process.platform &&
    manifest.environment_compatibility.architecture === process.arch &&
    manifest.environment_compatibility.node_version === `v${process.versions.node}`;
}

function validReleaseId(id: string): boolean {
  return /^r0-[0-9a-f]{40}$/.test(id);
}

async function readCurrent(paths: ReleasePaths): Promise<ReleaseResult<string | null>> {
  const path = join(paths.home, "current");
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return { ok: true, value: null };
    return managerFailed("current_absent");
  }
  if (!stat.isSymbolicLink()) return managerFailed("current_absent");
  try {
    const target = await readlink(path);
    const match = /^releases\/(r0-[0-9a-f]{40})$/.exec(target);
    const id = match?.[1];
    if (id === undefined) return managerFailed("current_absent");
    const selected = join(paths.releases, id);
    const selectedStat = await lstat(selected);
    if (!selectedStat.isDirectory() || selectedStat.isSymbolicLink() || !isDirectChild(paths.releases, await realpath(selected))) {
      return managerFailed("current_absent");
    }
    return { ok: true, value: id };
  } catch {
    return managerFailed("current_absent");
  }
}

async function validatedTarget(id: string, paths: ReleasePaths): Promise<ReleaseResult<ReleaseManifest>> {
  if (!validReleaseId(id)) return managerFailed("release_id_invalid");
  const target = join(paths.releases, id);
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) return managerFailed("selection_target_linked");
    if (!stat.isDirectory() || !isDirectChild(paths.releases, await realpath(target))) return managerFailed("selection_target_invalid");
    const parsed = await readReleaseManifest(join(target, "release-manifest.json"));
    if (!parsed.ok || parsed.value.version !== id) return managerFailed("selection_target_invalid");
    if (!compatible(parsed.value)) return managerFailed("selection_target_incompatible");
    return parsed;
  } catch (error) {
    if (isNotFound(error)) return managerFailed("selection_target_unknown");
    return managerFailed("selection_target_invalid");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLockOwner(path: string): Promise<ReleaseResult<LockOwner>> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(raw) || raw.schema_version !== 0 || typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0 || typeof raw.hostname !== "string" || raw.hostname.length === 0 || typeof raw.token !== "string" || raw.token.length === 0 || (raw.purpose !== undefined && raw.purpose !== "recovery")) {
      return managerFailed("install_lock_owner_unverifiable");
    }
    if (raw.purpose === "recovery") return { ok: true, value: { schema_version: 0, pid: raw.pid, hostname: raw.hostname, token: raw.token, purpose: "recovery" } };
    return { ok: true, value: { schema_version: 0, pid: raw.pid, hostname: raw.hostname, token: raw.token } };
  } catch {
    return managerFailed("install_lock_owner_unverifiable");
  }
}

async function installExclusiveLockMetadata(path: string, owner: LockOwner): Promise<ReleaseResult<boolean>> {
  const candidate = `${path}.candidate-${owner.token}`;
  try {
    await writeFile(candidate, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    try {
      await link(candidate, path);
      return { ok: true, value: true };
    } catch (error) {
      if (isAlreadyExists(error)) return { ok: true, value: false };
      return managerFailed("install_failed");
    }
  } catch {
    return managerFailed("install_failed");
  } finally {
    await unlink(candidate).catch(() => {});
  }
}

function lockProcessState(owner: LockOwner): "live" | "absent" | "unknown" {
  if (owner.hostname !== hostname()) return "live";
  try {
    process.kill(owner.pid, 0);
    return "live";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH" ? "absent" : "unknown";
  }
}

async function removeOwnerlessLock(lockPath: string, ownerPath: string, recoveryPath: string, hooks: ReleaseManagerHooks | undefined): Promise<boolean> {
  try {
    const original = await lstat(lockPath);
    if (!original.isDirectory() || original.isSymbolicLink()) return false;
    try {
      await lstat(ownerPath);
      return false;
    } catch (error) {
      if (!isNotFound(error)) return false;
    }
    // Claim recovery of this ownerless lock exclusively, using the same
    // hard-link publication as dead-owner recovery, so a fresh owner
    // publisher racing on the same lock generation can observe our claim
    // before or after it publishes and yield rather than being destroyed.
    const recovery: LockOwner = { schema_version: 0, pid: process.pid, hostname: hostname(), token: randomUUID(), purpose: "recovery" };
    const claimed = await installExclusiveLockMetadata(recoveryPath, recovery);
    if (!claimed.ok || !claimed.value) return false;
    try {
      await hooks?.afterExistingOwnerRead?.();
      let current;
      try {
        current = await lstat(lockPath);
      } catch (error) {
        return isNotFound(error);
      }
      if (current.ino !== original.ino || current.dev !== original.dev) return false;
      try {
        await lstat(ownerPath);
        return false;
      } catch (error) {
        if (!isNotFound(error)) return false;
      }
      const claim = await readLockOwner(recoveryPath);
      if (!claim.ok || claim.value.token !== recovery.token) return false;
      await hooks?.afterExistingOwnerRead?.();
      await rm(lockPath, { recursive: true, force: false });
      return true;
    } finally {
      const marker = await readLockOwner(recoveryPath);
      if (marker.ok && marker.value.token === recovery.token) await unlink(recoveryPath).catch(() => {});
    }
  } catch {
    return false;
  }
}

async function removeDeadRecoveryMarker(recoveryPath: string): Promise<ReleaseResult<boolean>> {
  try {
    await lstat(recoveryPath);
  } catch (error) {
    if (isNotFound(error)) return { ok: true, value: false };
    return managerFailed("install_lock_owner_unverifiable");
  }
  const marker = await readLockOwner(recoveryPath);
  if (!marker.ok) return marker;
  const state = lockProcessState(marker.value);
  if (state === "live") return { ok: true, value: false };
  if (state === "unknown") return managerFailed("install_lock_owner_unverifiable");
  try {
    const original = await lstat(recoveryPath);
    const current = await readLockOwner(recoveryPath);
    const reread = await lstat(recoveryPath);
    if (
      !current.ok ||
      current.value.token !== marker.value.token ||
      reread.ino !== original.ino ||
      reread.dev !== original.dev ||
      lockProcessState(current.value) !== "absent"
    ) return { ok: true, value: false };
    await unlink(recoveryPath);
    return { ok: true, value: true };
  } catch {
    return managerFailed("install_lock_owner_unverifiable");
  }
}

async function acquireInstallLock(paths: ReleasePaths, hooks: ReleaseManagerHooks | undefined): Promise<ReleaseResult<InstallLock>> {
  const lockPath = join(paths.releases, ".install-lock");
  const ownerPath = join(lockPath, "owner.json");
  const recoveryPath = `${lockPath}.recovery`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const lockStat = await lstat(lockPath);
      const recoveryBefore = await lstat(recoveryPath).catch(() => undefined);
      if (recoveryBefore !== undefined) {
        // A recoverer may claim this lock generation, or its marker may be a
        // dead orphan with no lock directory of its own to recover through
        // (since we just freshly created this one): reclaim a dead marker
        // outright, and otherwise yield instead of racing a hard-link
        // publish against a live recoverer's removal.
        await rm(lockPath, { recursive: true, force: false }).catch(() => {});
        const staleMarker = await removeDeadRecoveryMarker(recoveryPath);
        if (!staleMarker.ok) return staleMarker;
        continue;
      }
      await hooks?.afterExistingOwnerRead?.();
      const owner: LockOwner = { schema_version: 0, pid: process.pid, hostname: hostname(), token: randomUUID() };
      const installed = await installExclusiveLockMetadata(ownerPath, owner);
      if (!installed.ok || !installed.value) {
        await removeOwnerlessLock(lockPath, ownerPath, recoveryPath, hooks);
        return managerFailed("install_lock_owner_unverifiable");
      }
      await hooks?.afterExistingOwnerRead?.();
      const recoveryAfter = await lstat(recoveryPath).catch(() => undefined);
      if (recoveryAfter !== undefined) {
        // A recoverer claimed this lock generation around our publish;
        // token-clean our own owner/lock and never return acquired.
        const currentLock = await lstat(lockPath).catch(() => undefined);
        if (currentLock !== undefined && currentLock.ino === lockStat.ino && currentLock.dev === lockStat.dev) {
          const current = await readLockOwner(ownerPath);
          if (current.ok && current.value.token === owner.token) await unlink(ownerPath).catch(() => {});
          await rm(lockPath, { recursive: true, force: false }).catch(() => {});
        }
        continue;
      }
      // No recoverer claim is visible now, but a recoverer may already have
      // removed this lock generation (owner.json and all) and cleared its
      // marker before this read: require our own token plus the original
      // lock directory identity before ever reporting acquired.
      const publishedOwner = await readLockOwner(ownerPath);
      const publishedLock = await lstat(lockPath).catch(() => undefined);
      if (
        !publishedOwner.ok ||
        publishedOwner.value.token !== owner.token ||
        publishedLock === undefined ||
        publishedLock.ino !== lockStat.ino ||
        publishedLock.dev !== lockStat.dev
      ) continue;
      return { ok: true, value: { release: async () => {
        const current = await readLockOwner(ownerPath);
        const currentLock = await lstat(lockPath).catch(() => undefined);
        if (!current.ok || current.value.token !== owner.token || currentLock === undefined || currentLock.ino !== lockStat.ino || currentLock.dev !== lockStat.dev) return;
        await rm(lockPath, { recursive: true, force: false }).catch(() => {});
      } } };
    } catch (error) {
      if (!isAlreadyExists(error)) return managerFailed("install_failed");
    }
    const existing = await readLockOwner(ownerPath);
    if (!existing.ok) {
      const staleMarker = await removeDeadRecoveryMarker(recoveryPath);
      if (!staleMarker.ok) return staleMarker;
      if (staleMarker.value || await removeOwnerlessLock(lockPath, ownerPath, recoveryPath, hooks)) continue;
      return existing;
    }
    await hooks?.afterExistingOwnerRead?.();
    const state = lockProcessState(existing.value);
    if (state === "live") return managerFailed("install_lock_conflict");
    if (state === "unknown") return managerFailed("install_lock_owner_unverifiable");
    const recovery: LockOwner = { schema_version: 0, pid: process.pid, hostname: hostname(), token: randomUUID(), purpose: "recovery" };
    const marked = await installExclusiveLockMetadata(recoveryPath, recovery);
    if (!marked.ok) return marked;
    if (!marked.value) {
      const staleMarker = await removeDeadRecoveryMarker(recoveryPath);
      if (!staleMarker.ok) return staleMarker;
      if (staleMarker.value) continue;
      return managerFailed("install_lock_conflict");
    }
    try {
      const current = await readLockOwner(ownerPath);
      if (!current.ok) return current;
      if (current.value.token !== existing.value.token || lockProcessState(current.value) !== "absent") return managerFailed("install_lock_conflict");
      await rm(lockPath, { recursive: true, force: false });
    } catch {
      return managerFailed("install_lock_owner_unverifiable");
    } finally {
      const marker = await readLockOwner(recoveryPath);
      if (marker.ok && marker.value.token === recovery.token) await unlink(recoveryPath).catch(() => {});
    }
  }
  return managerFailed("install_lock_conflict");
}

function quotedShellPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

async function installLaunchers(paths: ReleasePaths, options: ReleaseManagerOptions): Promise<ReleaseResult<InstalledLauncher[]>> {
  const binDir = resolve(options.binDir ?? process.env.ENGRAM_BIN_DIR ?? join(homedir(), ".local", "bin"));
  const installed: InstalledLauncher[] = [];
  try {
    await mkdir(binDir, { recursive: true, mode: 0o755 });
    const binStat = await lstat(binDir);
    if (!binStat.isDirectory() || binStat.isSymbolicLink()) return managerFailed("launcher_conflict");
    const canonicalBin = await realpath(binDir);
    const definitions = [
      { name: "engram", content: `#!/bin/sh\nexec ${quotedShellPath(join(paths.home, "current", "bin", "engram"))} "$@"\n` },
      { name: "engram-release", content: `#!/bin/sh\nexec node ${quotedShellPath(join(paths.home, "current", "release", "engram-release.ts"))} "$@"\n` },
    ];
    for (const definition of definitions) {
      const launcherPath = join(canonicalBin, definition.name);
      try {
        const stat = await lstat(launcherPath);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0 || await readFile(launcherPath, "utf8") !== definition.content) {
          await cleanupLaunchers(installed);
          return managerFailed("launcher_conflict");
        }
      } catch (error) {
        if (!isNotFound(error)) {
          await cleanupLaunchers(installed);
          return managerFailed("launcher_conflict");
        }
        const temporary = join(canonicalBin, `.${definition.name}.${randomUUID()}.tmp`);
        try {
          const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o755);
          try {
            await handle.writeFile(definition.content, "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await chmod(temporary, 0o755);
          const candidate = await lstat(temporary);
          if (!candidate.isFile() || candidate.isSymbolicLink() || (candidate.mode & 0o777) !== 0o755) throw new Error("launcher mode");
          await link(temporary, launcherPath);
          installed.push({ path: launcherPath, ino: candidate.ino, dev: candidate.dev, content: definition.content });
          const published = await lstat(launcherPath);
          if (!published.isFile() || published.isSymbolicLink() || published.ino !== candidate.ino || published.dev !== candidate.dev) {
            throw new Error("launcher publication");
          }
          await chmod(launcherPath, 0o755);
          if (((await lstat(launcherPath)).mode & 0o777) !== 0o755) throw new Error("launcher mode");
          await unlink(temporary);
        } catch {
          await rm(temporary, { force: true });
          await cleanupLaunchers(installed);
          return managerFailed("launcher_conflict");
        }
      }
    }
    await syncDirectory(canonicalBin);
    return { ok: true, value: installed };
  } catch {
    await cleanupLaunchers(installed);
    return managerFailed("launcher_conflict");
  }
}

async function cleanupLaunchers(launchers: readonly InstalledLauncher[]): Promise<void> {
  for (const launcher of launchers) {
    try {
      const stat = await lstat(launcher.path);

      if (stat.isFile() && !stat.isSymbolicLink() && stat.ino === launcher.ino && stat.dev === launcher.dev && await readFile(launcher.path, "utf8") === launcher.content) {
        await rm(launcher.path);
      }
    } catch {
      continue;
    }
  }
}
async function sealAndVerifyStagedTree(root: string, entries: readonly ArchiveEntry[]): Promise<boolean> {
  try {
    const actual: string[] = [];
    const walk = async (relativePath: string): Promise<void> => {
      const directory = join(root, relativePath);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = relativePath.length === 0 ? entry.name : join(relativePath, entry.name);
        actual.push(child);
        if (entry.isDirectory()) await walk(child);
      }
    };
    await walk("");
    const expected = entries.map((entry) => entry.path).sort();
    actual.sort();
    if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) return false;
    for (const entry of entries) {
      const path = join(root, entry.path);
      const stat = await lstat(path);
      const expectedMode = entry.directory ? 0o755 : entry.mode;
      if (stat.isSymbolicLink() || stat.isDirectory() !== entry.directory || (stat.mode & 0o7777) !== expectedMode) return false;
      if (!entry.directory) {
        const bytes = await readFile(path);
        if (bytes.length !== entry.bytes.length || sha256Bytes(bytes) !== sha256Bytes(entry.bytes)) return false;
      }
    }
    for (const entry of entries.filter((candidate) => !candidate.directory)) {
      const path = join(root, entry.path);
      await chmod(path, entry.mode === 0o755 ? 0o555 : 0o444);
      await syncDirectory(path);
    }
    for (const path of [...actual].sort((left, right) => right.length - left.length)) {
      const fullPath = join(root, path);
      const stat = await lstat(fullPath);
      if (stat.isDirectory()) {
        await chmod(fullPath, 0o555);
        await syncDirectory(fullPath);
      }
    }
    await syncDirectory(root);
    return true;
  } catch {
    return false;
  }
}

async function makeTreeWritable(root: string): Promise<void> {
  try {
    const walk = async (path: string): Promise<void> => {
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        await chmod(path, 0o755);
        for (const entry of await readdir(path)) await walk(join(path, entry));
      } else {
        await chmod(path, 0o644);
      }
    };
    await walk(root);
  } catch {
    return;
  }
}

export async function installRelease(archivePath: string, recordPath: string, options: ReleaseManagerOptions = {}): Promise<ReleaseResult<{ release_id: string }>> {
  let record: ReleaseRecord;
  let archive: Buffer;
  try {
    const raw = JSON.parse(await readFile(recordPath, "utf8"));
    const parsed = parseReleaseRecord(raw);
    if (!parsed.ok) {
      const detail = isRecord(raw) && typeof raw.source_revision === "string" ? raw.source_revision : undefined;
      return managerFailure("release_record_invalid", managerErrorMessage("release_record_invalid"), undefined, detail);
    }
    record = parsed.value;
    archive = await readFile(archivePath);
  } catch {
    return managerFailed("release_record_invalid");
  }
  if (
    archive.length !== record.artifact_integrity.archive.byte_length ||
    sha256Bytes(archive) !== record.artifact_integrity.archive.sha256 ||
    basename(archivePath) !== record.artifact_integrity.archive.filename
  ) return managerFailed("artifact_integrity_mismatch");
  const inspected = await inspectArchive(archive);
  if (!inspected.ok) return inspected;
  const manager = inspected.value.entries.find((entry) => entry.path === "release/engram-release.ts" && !entry.directory);
  if (
    manager === undefined ||
    manager.bytes.length !== record.artifact_integrity.bootstrap.byte_length ||
    sha256Bytes(manager.bytes) !== record.artifact_integrity.bootstrap.sha256
  ) return managerFailed("artifact_integrity_mismatch");
  if (
    inspected.value.manifest.version !== record.version ||
    inspected.value.manifest.source_revision !== record.source_revision
  ) return managerFailed("release_identity_mismatch");
  if (!compatible(inspected.value.manifest)) return managerFailed("release_incompatible");
  const pathResult = await physicalPaths(options, true);
  if (!pathResult.ok) return pathResult;
  const paths = pathResult.value;
  const finalPath = join(paths.releases, record.version);
  try {
    await lstat(finalPath);
    return managerFailed("release_exists");
  } catch (error) {
    if (!isNotFound(error)) return managerFailed("install_failed");
  }
  const lock = await acquireInstallLock(paths, options.hooks);
  if (!lock.ok) return lock;
  let staging = "";
  let launchers: InstalledLauncher[] = [];
  let committed = false;
  try {
    staging = join(paths.releases, `.staging-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    const canonicalStaging = await realpath(staging);
    if (!isDirectChild(paths.releases, canonicalStaging)) return managerFailed("release_boundary_unsafe");
    for (const entry of inspected.value.entries) {
      if (entry.directory) continue;
      const destination = join(canonicalStaging, entry.path);
      const parent = dirname(destination);
      await mkdir(parent, { recursive: true, mode: 0o755 });
      const canonicalParent = await realpath(parent);
      if (!isWithin(canonicalStaging, canonicalParent)) return managerFailed("release_boundary_unsafe");
      const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.mode);
      try {
        await handle.writeFile(entry.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(destination, entry.mode);
      const written = await readFile(destination);
      if (written.length !== entry.bytes.length || sha256Bytes(written) !== sha256Bytes(entry.bytes)) return managerFailed("install_failed");
      await syncDirectory(canonicalParent);
    }
    for (const entry of inspected.value.entries) {
      if (!entry.directory) continue;
      const directory = join(canonicalStaging, entry.path);
      const stat = await lstat(directory);
      const canonicalDirectory = await realpath(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(canonicalStaging, canonicalDirectory)) {
        return managerFailed("release_boundary_unsafe");
      }
      await chmod(directory, 0o755);
    }
    const launchResult = await installLaunchers(paths, options);
    if (!launchResult.ok) return launchResult;
    launchers = launchResult.value;
    await options.hooks?.afterLaunchersInstalled?.();
    if (!await sealAndVerifyStagedTree(canonicalStaging, inspected.value.entries)) return managerFailed("install_failed");
    try {
      await lstat(finalPath);
      return managerFailed("release_exists");
    } catch (error) {
      if (!isNotFound(error)) return managerFailed("install_failed");
    }
    await rename(canonicalStaging, finalPath);
    committed = true;
    await chmod(finalPath, 0o555);
    await syncDirectory(finalPath);
    await syncDirectory(paths.releases);
    const selected = await readCurrent(paths);
    if (!selected.ok) return selected;
    if (selected.value === null) {
      const selection = await selectRelease(record.version, options);
      if (!selection.ok) return selection;
    }
    return { ok: true, value: { release_id: record.version } };
  } catch {
    return managerFailed("install_failed");
  } finally {
    if (!committed) {
      if (staging.length > 0) {
        await makeTreeWritable(staging);
        await rm(staging, { recursive: true, force: true });
      }
      await cleanupLaunchers(launchers);
    }
    await lock.value.release();
  }
}
export async function selectRelease(releaseId: string, options: ReleaseManagerOptions = {}): Promise<ReleaseResult<{ release_id: string }>> {
  const pathResult = await physicalPaths(options, false);
  if (!pathResult.ok) return pathResult;
  const paths = pathResult.value;
  const target = await validatedTarget(releaseId, paths);
  if (!target.ok) return target;
  const temporary = join(paths.home, `.current-${randomUUID()}`);
  try {
    await symlink(join("releases", releaseId), temporary);
    await options.hooks?.beforeSelectionRename?.();
    const revalidated = await validatedTarget(releaseId, paths);
    if (!revalidated.ok) return revalidated;
    await rename(temporary, join(paths.home, "current"));
    await syncDirectory(paths.home);
    return { ok: true, value: { release_id: releaseId } };
  } catch {
    return managerFailed("install_failed");
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function listReleases(options: ReleaseManagerOptions = {}): Promise<ReleaseResult<{ release_ids: string[]; selected_release_id: string | null }>> {
  const pathResult = await physicalPaths(options, false);
  if (!pathResult.ok) {
    if (pathResult.errors[0]?.code === "selection_target_unknown") return { ok: true, value: { release_ids: [], selected_release_id: null } };
    return pathResult;
  }
  const ids: string[] = [];
  try {
    for (const entry of await readdir(pathResult.value.releases, { withFileTypes: true })) {
      if (entry.name.startsWith(".staging-") || entry.name === ".install-lock") continue;
      if (!validReleaseId(entry.name)) {
        if (entry.isDirectory()) return managerFailed("selection_target_invalid");
        continue;
      }
      const target = await validatedTarget(entry.name, pathResult.value);
      if (!target.ok) return target;
      ids.push(entry.name);
    }
    ids.sort();
    const selected = await readCurrent(pathResult.value);
    if (!selected.ok) return selected;
    return { ok: true, value: { release_ids: ids, selected_release_id: selected.value } };
  } catch {
    return managerFailed("selection_target_invalid");
  }
}

export async function currentRelease(options: ReleaseManagerOptions = {}): Promise<ReleaseResult<string | null>> {
  const pathResult = await physicalPaths(options, false);
  if (!pathResult.ok) {
    if (pathResult.errors[0]?.code === "selection_target_unknown") return { ok: true, value: null };
    return pathResult;
  }
  const selected = await readCurrent(pathResult.value);
  if (!selected.ok || selected.value === null) return selected;
  const target = await validatedTarget(selected.value, pathResult.value);
  if (!target.ok) return managerFailed("current_absent");
  return selected;
}

function projectReleaseErrors(errors: readonly ReleaseError[]): { code: ReleaseErrorCode; message: string; field?: string }[] {
  return errors.map((error) => ({ code: error.code, message: error.message, ...(error.field === undefined ? {} : { field: error.field }) }));
}

export async function runReleaseManager(argv: readonly string[], options: ReleaseManagerOptions = {}): Promise<number> {
  const writeStdout = options.stdout ?? ((message: string) => process.stdout.write(message));
  const writeStderr = options.stderr ?? ((message: string) => process.stderr.write(message));
  const output = (value: object): void => writeStdout(`${JSON.stringify(value)}\n`);
  const failure = (result: ReleaseResult<unknown>): number => {
    if (result.ok) return 0;
    output({ schema_version: 0, status: "failed", errors: projectReleaseErrors(result.errors) });
    return 1;
  };
  if (argv[0] === "install" && argv.length === 3) {
    const result = await installRelease(argv[1] ?? "", argv[2] ?? "", options);
    if (!result.ok) return failure(result);
    output({ schema_version: 0, status: "installed" });
    return 0;
  }
  if (argv[0] === "select" && argv.length === 2) {
    const result = await selectRelease(argv[1] ?? "", options);
    if (!result.ok) return failure(result);
    output({ schema_version: 0, status: "selected" });
    return 0;
  }
  if (argv[0] === "list" && argv.length === 1) {
    const result = await listReleases(options);
    if (!result.ok) return failure(result);
    output({ schema_version: 0, status: "listed", release_ids: result.value.release_ids, selected_release_id: result.value.selected_release_id });
    return 0;
  }
  if (argv[0] === "current" && argv.length === 1) {
    const result = await currentRelease(options);
    if (!result.ok) return failure(result);
    output({ schema_version: 0, status: "current", release_id: result.value });
    return 0;
  }
  writeStderr("release_manager_command_invalid\n");
  return 1;
}

// `endsWith("/release/engram-release.ts")` would only match this file at
// its development-tree path; a packaged release copies and renames this
// exact file to a standalone bootstrap (e.g. `engram-release-r0-<rev>.ts`)
// for install, so the entrypoint must recognize "this file is the one
// actually being executed" regardless of what it is named or where it
// lives, not one hardcoded path shape. The installed `engram-release`
// launcher always execs through the `current` symlink, and Node's ESM
// loader resolves `import.meta.url` to the symlink target's real path
// while `process.argv[1]` keeps the literal (symlinked) invocation path
// — so the comparison must realpath the invoked path too, or every
// invocation through `current` would silently no-op.
let invokedEntrypoint: string | undefined;
try {
  invokedEntrypoint = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
} catch {
  invokedEntrypoint = undefined;
}
if (invokedEntrypoint === fileURLToPath(import.meta.url)) {
  void runReleaseManager(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
