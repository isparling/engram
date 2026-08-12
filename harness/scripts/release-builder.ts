import { execFile as execFileCallback } from "node:child_process";
import type { Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  PACKAGING_PROCEDURE_VERSION,
  canonicalReleaseJson,
  parseReleaseManifest,
  parseReleaseRecord,
  type ReleaseArtifactIntegrity,
  type ReleaseFileIntegrity,
  type ReleaseManifest,
  type ReleaseRecord,
} from "../../release/engram-release.ts";
import { inspectStagedFiles, readGzipUstar, type ArchiveInput, writeGzipUstar } from "./release-archive.ts";

const execFile = promisify(execFileCallback);
const RUNTIME_PACKAGE = '{"name":"engram-harness","private":true,"type":"module"}\n';
const ALLOWED_FILES = ["bin/engram", "release/engram-release.ts"] as const;
const ALLOWED_TREES = ["harness/src"] as const;
const REQUIRED_RUNTIME_FILES = ["bin/engram", "harness/src/cli.ts", "release/engram-release.ts"] as const;

export type StageReleaseInput = {
  repoRoot: string;
  stageRoot: string;
  sourceRevision: string;
  nodeVersion: string;
  qmdVersion: string;
};

export type GitRunResult = { stdout: string; exitCode: number };
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitRunResult>;

export type SourceAttribution =
  | { ok: true; sourceRevision: string }
  | { ok: false; error: { code: "source_revision_invalid" | "source_dirty"; message: string } };

export class ReleaseBuildError extends Error {
  readonly code: "source_revision_invalid" | "source_dirty" | "source_revision_mismatch" | "stage_invalid";

  constructor(code: ReleaseBuildError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type StagedRelease = {
  stageRoot: string;
  archivePath: string;
  files: ReleaseFileIntegrity[];
  manifest: ReleaseManifest;
};

export type BuildReleaseCandidateInput = StageReleaseInput & {
  outputRoot: string;
  runner?: GitRunner;
  archiveReader?: (archive: Buffer) => readonly ArchiveInput[];
  publishedAt?: string;
};

export type ReleaseCandidate = {
  releaseId: string;
  sourceRevision: string;
  stageRoot: string;
  archivePath: string;
  bootstrapPath: string;
  archiveIntegrity: ReleaseArtifactIntegrity;
  bootstrapIntegrity: ReleaseArtifactIntegrity;
  manifest: ReleaseManifest;
  record: ReleaseRecord;
};

async function defaultGitRunner(args: readonly string[], cwd: string): Promise<GitRunResult> {
  try {
    const result = await execFile("git", [...args], { cwd });
    return { stdout: result.stdout, exitCode: 0 };
  } catch (error) {
    const stdout = error instanceof Error && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    return { stdout, exitCode: 1 };
  }
}

function validRevision(revision: string): boolean {
  return /^[0-9a-f]{40}$/.test(revision);
}

export async function identifyCleanSource(repoRoot: string, runner: GitRunner = defaultGitRunner): Promise<SourceAttribution> {
  const revision = await runner(["rev-parse", "HEAD"], repoRoot);
  const sourceRevision = revision.stdout.trim();
  if (revision.exitCode !== 0 || !validRevision(sourceRevision)) {
    return { ok: false, error: { code: "source_revision_invalid", message: "source revision is unavailable or invalid" } };
  }
  const status = await runner(["status", "--porcelain=v1", "--untracked-files=all"], repoRoot);
  if (status.exitCode !== 0 || status.stdout.length !== 0) {
    return { ok: false, error: { code: "source_dirty", message: "source tree must be clean before release staging" } };
  }
  return { ok: true, sourceRevision };
}

function assertSourceRevision(sourceRevision: string): void {
  if (!validRevision(sourceRevision)) throw new ReleaseBuildError("source_revision_invalid", "source revision is invalid");
}

function safeTrackedPath(path: string): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) throw new ReleaseBuildError("stage_invalid", "tracked source path is unsafe");
  return path;
}

async function trackedAllowedFiles(repoRoot: string, runner: GitRunner): Promise<string[]> {
  const tracked = await runner(
    ["ls-files", "-z", "--", ...ALLOWED_FILES, ...ALLOWED_TREES.map((tree) => `${tree}/**`)],
    repoRoot,
  );
  if (tracked.exitCode !== 0) throw new ReleaseBuildError("stage_invalid", "allowed tracked source files are unavailable");
  const paths = tracked.stdout.split("\0").filter((path) => path.length > 0).map(safeTrackedPath).sort();
  const duplicates = paths.some((path, index) => index > 0 && path === paths[index - 1]);
  if (duplicates) throw new ReleaseBuildError("stage_invalid", "allowed tracked source files are duplicated");
  return paths;
}

async function copyTrackedFile(repoRoot: string, stageRoot: string, path: string): Promise<void> {
  const source = resolve(repoRoot, path);
  let lexicalSourceStat: Stats;
  let canonicalRoot: string;
  let canonicalSource: string;
  try {
    lexicalSourceStat = await lstat(source);
    [canonicalRoot, canonicalSource] = await Promise.all([realpath(repoRoot), realpath(source)]);
  } catch {
    throw new ReleaseBuildError("stage_invalid", "tracked source cannot be physically resolved");
  }
  if (!lexicalSourceStat.isFile() || lexicalSourceStat.isSymbolicLink()) {
    throw new ReleaseBuildError("stage_invalid", "tracked source is not a regular file");
  }
  if (canonicalSource !== canonicalRoot && !canonicalSource.startsWith(`${canonicalRoot}${sep}`)) {
    throw new ReleaseBuildError("stage_invalid", "tracked source escapes repository root");
  }
  const canonicalSourceStat = await lstat(canonicalSource);
  if (!canonicalSourceStat.isFile() || canonicalSourceStat.isSymbolicLink()) {
    throw new ReleaseBuildError("stage_invalid", "tracked source is not a regular file");
  }
  const destination = join(stageRoot, path);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(canonicalSource, destination);
  await chmod(destination, (canonicalSourceStat.mode & 0o111) === 0 ? 0o644 : 0o755);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileIntegrity(path: string, bytes: Buffer, executable: boolean): ReleaseFileIntegrity {
  return { path, byte_length: bytes.length, sha256: sha256(bytes), executable };
}

function releaseId(sourceRevision: string): string {
  return `r0-${sourceRevision}`;
}

export type ReleaseArtifactNames = {
  releaseId: string;
  archiveName: string;
  bootstrapName: string;
  recordName: string;
};

/**
 * Single source of truth for the exact three filenames a qualified R0
 * release set publishes under (archive, bootstrap, record), so the
 * qualification orchestrator (harness/scripts/release.ts) never
 * re-derives — and risks drifting from — the naming convention this
 * module already uses for the archive and bootstrap artifacts.
 */
export function releaseArtifactNames(sourceRevision: string): ReleaseArtifactNames {
  const id = releaseId(sourceRevision);
  return {
    releaseId: id,
    archiveName: `engram-${id}.tar.gz`,
    bootstrapName: `engram-release-${id}.ts`,
    recordName: `engram-${id}.release.json`,
  };
}

function qualifiedNodeVersion(nodeVersion: string): string {
  return nodeVersion.startsWith("v") ? nodeVersion : `v${nodeVersion}`;
}

function createManifest(input: StageReleaseInput, files: readonly ReleaseFileIntegrity[]): ReleaseManifest {
  return {
    schema_version: 0,
    release_format: 0,
    version: releaseId(input.sourceRevision),
    source_revision: input.sourceRevision,
    packaging_procedure_version: PACKAGING_PROCEDURE_VERSION,
    host_agent_compatibility: "host-neutral-cli-schema-0",
    qmd_compatibility: { contract: "scoped-cli", version: input.qmdVersion },
    knowledge_schema_compatibility: ["0"],
    pack_api_compatibility: 0,
    environment_compatibility: { platform: "darwin", architecture: "arm64", node_version: qualifiedNodeVersion(input.nodeVersion) },
    included_packs: [],
    files: [...files],
  };
}

function requireManifest(manifest: ReleaseManifest): ReleaseManifest {
  const parsed = parseReleaseManifest(manifest);
  if (!parsed.ok) throw new ReleaseBuildError("stage_invalid", "generated release manifest is invalid");
  return parsed.value;
}

export async function stageRelease(input: StageReleaseInput, runner: GitRunner = defaultGitRunner): Promise<StagedRelease> {
  assertSourceRevision(input.sourceRevision);
  const paths = await trackedAllowedFiles(input.repoRoot, runner);
  if (REQUIRED_RUNTIME_FILES.some((path) => !paths.includes(path))) {
    throw new ReleaseBuildError("stage_invalid", "tracked runtime inventory is incomplete");
  }
  await rm(input.stageRoot, { recursive: true, force: true });
  await mkdir(input.stageRoot, { recursive: true });
  for (const path of paths) await copyTrackedFile(input.repoRoot, input.stageRoot, path);
  const packagePath = join(input.stageRoot, "harness", "package.json");
  await mkdir(dirname(packagePath), { recursive: true });
  await writeFile(packagePath, RUNTIME_PACKAGE, "utf8");

  const stagedBeforeManifest = await inspectStagedFiles(input.stageRoot);
  const manifestFiles = stagedBeforeManifest
    .map((entry) => fileIntegrity(entry.path, entry.bytes, entry.executable))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = requireManifest(createManifest(input, manifestFiles));
  await writeFile(join(input.stageRoot, "release-manifest.json"), canonicalReleaseJson(manifest), "utf8");

  const archiveEntries = await inspectStagedFiles(input.stageRoot);
  const finalFiles = archiveEntries.map((entry) => fileIntegrity(entry.path, entry.bytes, entry.executable));
  if (finalFiles.some((entry) =>
    entry.path !== "bin/engram" &&
    entry.path !== "harness/package.json" &&
    !entry.path.startsWith("harness/src/") &&
    entry.path !== "release/engram-release.ts" &&
    entry.path !== "release-manifest.json"
  )) {
    throw new ReleaseBuildError("stage_invalid", "staged inventory is outside the runtime allowlist");
  }
  const archivePath = `${input.stageRoot}.tar.gz`;
  await writeGzipUstar(archiveEntries, archivePath);
  return { stageRoot: input.stageRoot, archivePath, files: finalFiles, manifest };
}

function artifactIntegrity(filename: string, bytes: Buffer): ReleaseArtifactIntegrity {
  return { filename, byte_length: bytes.length, sha256: sha256(bytes) };
}

function requireRecord(record: ReleaseRecord): ReleaseRecord {
  const parsed = parseReleaseRecord(record);
  if (!parsed.ok) throw new ReleaseBuildError("stage_invalid", "generated release record is invalid");
  return parsed.value;
}

export async function buildReleaseCandidate(input: BuildReleaseCandidateInput): Promise<ReleaseCandidate> {
  const cleanSource = await identifyCleanSource(input.repoRoot, input.runner ?? defaultGitRunner);
  if (!cleanSource.ok) throw new ReleaseBuildError(cleanSource.error.code, cleanSource.error.message);
  if (cleanSource.sourceRevision !== input.sourceRevision) {
    throw new ReleaseBuildError("source_revision_mismatch", "requested source revision does not match clean source attribution");
  }
  const staged = await stageRelease(input);
  const { releaseId: id, archiveName, bootstrapName } = releaseArtifactNames(input.sourceRevision);
  const archivePath = join(input.outputRoot, archiveName);
  const bootstrapPath = join(input.outputRoot, bootstrapName);
  const archiveBytes = await readFile(staged.archivePath);
  let inspectedFiles: ReleaseFileIntegrity[];
  try {
    inspectedFiles = [...(input.archiveReader ?? readGzipUstar)(archiveBytes)]
      .map((entry) => fileIntegrity(entry.path, entry.bytes, entry.executable))
      .sort((left, right) => left.path.localeCompare(right.path));
  } catch {
    throw new ReleaseBuildError("stage_invalid", "generated archive cannot be inspected");
  }
  if (
    inspectedFiles.length !== staged.files.length ||
    inspectedFiles.some((entry, index) => {
      const stagedFile = staged.files[index];
      if (stagedFile === undefined) return true;
      return entry.path !== stagedFile.path ||
        entry.byte_length !== stagedFile.byte_length ||
        entry.sha256 !== stagedFile.sha256 ||
        entry.executable !== stagedFile.executable;
    })
  ) {
    throw new ReleaseBuildError("stage_invalid", "generated archive inventory does not match staging");
  }
  const bootstrapBytes = await readFile(join(input.stageRoot, "release", "engram-release.ts"));
  const archiveIntegrity = artifactIntegrity(archiveName, archiveBytes);
  const bootstrapIntegrity = artifactIntegrity(bootstrapName, bootstrapBytes);
  const record = requireRecord({
    schema_version: 0,
    version: id,
    source_revision: input.sourceRevision,
    packaging_procedure_version: PACKAGING_PROCEDURE_VERSION,
    host_agent_compatibility: "host-neutral-cli-schema-0",
    qmd_compatibility: { contract: "scoped-cli", version: input.qmdVersion },
    knowledge_schema_compatibility: ["0"],
    pack_api_compatibility: 0,
    environment_compatibility: { platform: "darwin", architecture: "arm64", node_version: qualifiedNodeVersion(input.nodeVersion) },
    included_packs: [],
    included_beads: [],
    verification_summary: [{
      command: "repository archive inspection",
      outcome: "passed",
      mode: "automated",
      artifact_sha256: archiveIntegrity.sha256,
    }],
    known_limitations: ["R0 supports only the qualified Darwin arm64 environment."],
    artifact_integrity: { archive: archiveIntegrity, bootstrap: bootstrapIntegrity },
    published_at: input.publishedAt ?? new Date().toISOString(),
  });
  await mkdir(input.outputRoot, { recursive: true });
  for (const finalPath of [archivePath, bootstrapPath]) {
    try {
      await lstat(finalPath);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "ENOENT") continue;
      throw new ReleaseBuildError("stage_invalid", "candidate artifact destination cannot be inspected");
    }
    throw new ReleaseBuildError("stage_invalid", "candidate artifact destination already exists");
  }
  const publicationToken = randomUUID();
  const archiveTempPath = join(input.outputRoot, `.${archiveName}.${publicationToken}.tmp`);
  const bootstrapTempPath = join(input.outputRoot, `.${bootstrapName}.${publicationToken}.tmp`);
  let archivePublished = false;
  let bootstrapPublished = false;
  try {
    await writeFile(archiveTempPath, archiveBytes, { flag: "wx" });
    await writeFile(bootstrapTempPath, bootstrapBytes, { flag: "wx" });
    await rename(archiveTempPath, archivePath);
    archivePublished = true;
    await rename(bootstrapTempPath, bootstrapPath);
    bootstrapPublished = true;
  } catch {
    await Promise.all([
      rm(archiveTempPath, { force: true }),
      rm(bootstrapTempPath, { force: true }),
      archivePublished ? rm(archivePath, { force: true }) : Promise.resolve(),
      bootstrapPublished ? rm(bootstrapPath, { force: true }) : Promise.resolve(),
    ]);
    throw new ReleaseBuildError("stage_invalid", "candidate artifacts cannot be published");
  }
  return {
    releaseId: id,
    sourceRevision: input.sourceRevision,
    stageRoot: input.stageRoot,
    archivePath,
    bootstrapPath,
    archiveIntegrity,
    bootstrapIntegrity,
    manifest: staged.manifest,
    record,
  };
}
