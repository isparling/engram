import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

import { buildReleaseCandidate } from "../scripts/release-builder.ts";
import { readGzipUstar, writeGzipUstar } from "../scripts/release-archive.ts";
import { createSyntheticReleaseSource, destroySyntheticReleaseSource, replaceSyntheticReleaseFile, type SyntheticReleaseSource } from "./releaseTestSupport.ts";
import {
  canonicalReleaseJson,
  currentRelease,
  installRelease,
  listReleases,
  runReleaseManager,
  selectRelease,
  type ReleaseManagerOptions,
  type ReleaseResult,
} from "../../release/engram-release.ts";

const execFile = promisify(execFileCallback);
const sources: SyntheticReleaseSource[] = [];

after(async () => {
  await Promise.all(sources.map(destroySyntheticReleaseSource));
});

type InstallFixture = {
  source: SyntheticReleaseSource;
  root: string;
  archivePath: string;
  recordPath: string;
  releaseId: string;
  options: ReleaseManagerOptions;
  stagingRoot: string;
};


async function finishFixture(source: SyntheticReleaseSource): Promise<InstallFixture> {
  const candidate = await buildReleaseCandidate({
    repoRoot: source.root,
    stageRoot: source.stage,
    outputRoot: source.output,
    sourceRevision: source.revision,
    nodeVersion: process.versions.node,
    qmdVersion: "qmd synthetic-0",
    publishedAt: "2026-08-08T00:00:00.000Z",
  });
  const recordPath = join(source.root, "record.json");
  await writeFile(recordPath, canonicalReleaseJson(candidate.record), "utf8");
  const root = join(source.root, "installation");
  return {
    source,
    root,
    archivePath: candidate.archivePath,
    recordPath,
    releaseId: candidate.releaseId,
    options: { releaseHome: root, binDir: join(source.root, "stable-bin") },
    stagingRoot: join(root, "releases"),
  };
}

async function fixture(withRunnableEngram = false): Promise<InstallFixture> {
  const source = await createSyntheticReleaseSource();
  sources.push(source);
  if (withRunnableEngram) {
    await replaceSyntheticReleaseFile(
      source,
      "bin/engram",
      `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const here = dirname(new URL(import.meta.url).pathname);
const manifest = JSON.parse(await readFile(join(here, '..', 'release-manifest.json'), 'utf8'));
console.log(JSON.stringify({ release_id: manifest.version }));
// fixture ${sources.length}
`,
      true,
    );
  }
  return finishFixture(source);
}

// The packaged `bin/engram` must be executable pure shell. Its only external
// program is node, resolved through PATH; the qualification orchestrator's
// scoped smoke environment (`smokeEnv` in harness/scripts/release.ts) puts
// exactly the running node's bin directory on PATH and nothing else, so a
// launcher depending on dirname/basename/readlink fails step 13.
const MINIMAL_PATH_FIXTURE_CLI = `import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const registryPath = process.env.ENGRAM_BINDING_REGISTRY;
const sessionId = process.env.ENGRAM_HOST_SESSION_ID;
if (!registryPath || !sessionId) {
  console.error('missing synthetic space binding');
  process.exit(1);
}
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const registered = registry.spaces.map((entry) => entry.space_id);
const activeId = registry.active[sessionId];
if (registered.length !== 1 || activeId !== registered[0]) {
  console.error('synthetic space is not exclusively registered and selected');
  process.exit(1);
}
const physicalDir = realpathSync(new URL('.', import.meta.url).pathname);
console.log(JSON.stringify({
  schema_version: 0,
  registered_spaces: registered,
  active_spaces: { [sessionId]: { space_id: activeId } },
  last_boundary_error: registry.last_boundary_error ?? null,
  physical_dir: physicalDir,
}));
`;

async function fixtureWithRealLauncher(): Promise<InstallFixture> {
  const source = await createSyntheticReleaseSource();
  sources.push(source);
  const realLauncher = await readFile(new URL("../../bin/engram", import.meta.url), "utf8");
  await replaceSyntheticReleaseFile(source, "bin/engram", realLauncher, true);
  await replaceSyntheticReleaseFile(source, "harness/src/cli.ts", MINIMAL_PATH_FIXTURE_CLI);
  return finishFixture(source);
}

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  if (resolve === undefined) throw new Error("deferred resolver is unavailable");
  return { promise, resolve };
}

function managerOptions(options: ReleaseManagerOptions): ReleaseManagerOptions {
  const result: ReleaseManagerOptions = {};
  if (options.releaseHome !== undefined) result.releaseHome = options.releaseHome;
  if (options.binDir !== undefined) result.binDir = options.binDir;
  if (options.executablePath !== undefined) result.executablePath = options.executablePath;
  if (options.hooks !== undefined) result.hooks = options.hooks;
  return result;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyReleaseErrorCode(result: ReleaseResult<unknown>): string {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected release error");
  assert.equal(result.errors.length, 1);
  return result.errors[0]?.code ?? "";
}

async function readCurrentId(options: ReleaseManagerOptions): Promise<string | null> {
  const releaseHome = options.releaseHome;
  assert.ok(releaseHome);
  try {
    const target = await readlink(join(releaseHome, "current"));
    const match = /^releases\/(r0-[0-9a-f]{40})$/.exec(target);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function flipOneArchiveByte(path: string): Promise<void> {
  const archive = await readFile(path);
  const changed = Buffer.from(archive);
  const index = Math.max(0, changed.length - 20);
  changed[index] = (changed[index] ?? 0) ^ 1;
  await writeFile(path, changed);
}

function recomputeUstarChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
}

async function rewriteArchiveHeader(created: InstallFixture, transform: (archive: Buffer) => void): Promise<void> {
  const original = await readFile(created.archivePath);
  const archive = gunzipSync(original);
  transform(archive);
  recomputeUstarChecksum(archive.subarray(0, 512));
  const rewritten = gzipSync(archive);
  await writeFile(created.archivePath, rewritten);
  const record = await readFile(created.recordPath, "utf8");
  await writeFile(
    created.recordPath,
    record
      .replaceAll(createHash("sha256").update(original).digest("hex"), createHash("sha256").update(rewritten).digest("hex"))
      .replace(`"byte_length":${original.length},"filename"`, `"byte_length":${rewritten.length},"filename"`),
    "utf8",
  );
}

async function updateRecordArchiveIntegrity(created: InstallFixture, original: Buffer): Promise<void> {
  const replacement = await readFile(created.archivePath);
  const raw: unknown = JSON.parse(await readFile(created.recordPath, "utf8"));
  if (
    !recordValue(raw) ||
    !recordValue(raw.artifact_integrity) ||
    !recordValue(raw.artifact_integrity.archive) ||
    !Array.isArray(raw.verification_summary)
  ) throw new Error("fixture record is invalid");
  raw.artifact_integrity.archive.byte_length = replacement.length;
  raw.artifact_integrity.archive.sha256 = createHash("sha256").update(replacement).digest("hex");
  for (const verification of raw.verification_summary) {
    if (!recordValue(verification)) throw new Error("fixture verification is invalid");
    if (verification.artifact_sha256 === createHash("sha256").update(original).digest("hex")) {
      verification.artifact_sha256 = raw.artifact_integrity.archive.sha256;
    }
  }
  await writeFile(created.recordPath, canonicalReleaseJson(raw), "utf8");
}

async function removeArchiveEntry(created: InstallFixture, path: string): Promise<void> {
  const original = await readFile(created.archivePath);
  const entries = readGzipUstar(original).filter((entry) => entry.path !== path);
  await writeGzipUstar(entries, created.archivePath);
  await updateRecordArchiveIntegrity(created, original);
}

async function rewriteArchiveDirectoryMode(created: InstallFixture, mode: number): Promise<void> {
  const original = await readFile(created.archivePath);
  const archive = gunzipSync(original);
  let offset = 0;
  while (offset + 1024 <= archive.length && archive.subarray(offset, offset + 512).some((byte) => byte !== 0)) {
    const header = archive.subarray(offset, offset + 512);
    const length = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    if (header[156] === "5".charCodeAt(0)) {
      header.fill(0, 100, 108);
      header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "ascii");
      recomputeUstarChecksum(header);
      await writeFile(created.archivePath, gzipSync(archive));
      await updateRecordArchiveIntegrity(created, original);
      return;
    }
    offset += 512 + Math.ceil(length / 512) * 512;
  }
  throw new Error("fixture archive contains no directory header");
}

async function assertContainmentFailure(created: InstallFixture, expected: string, outsideSentinel: string): Promise<void> {
  assert.equal(onlyReleaseErrorCode(await install(created)), expected);
  assert.equal(await readCurrentId(created.options), null);
  assert.equal(await readFile(join(created.root, "outside-sentinel"), "utf8"), outsideSentinel);
  try {
    const releases = await readdir(created.stagingRoot);
    assert.equal(releases.some((entry) => entry.startsWith(".staging-")), false);
  } catch {
    // A preflight refusal need not create releases.
  }
  await assert.rejects(readFile(join(created.stagingRoot, created.releaseId, "release-manifest.json")));
}

async function install(fixtureToInstall: InstallFixture) {
  return installRelease(fixtureToInstall.archivePath, fixtureToInstall.recordPath, fixtureToInstall.options);
}

async function treeSnapshot(root: string): Promise<string[]> {
  const snapshot: string[] = [];
  const walk = async (path: string, relativePath: string): Promise<void> => {
    const stat = await lstat(path);
    let content: string;
    if (stat.isDirectory()) {
      content = createHash("sha256").update("").digest("hex");
    } else if (stat.isSymbolicLink()) {
      content = createHash("sha256").update(await readlink(path)).digest("hex");
    } else {
      content = createHash("sha256").update(await readFile(path)).digest("hex");
    }
    snapshot.push(`${relativePath || "."}:${stat.mode & 0o7777}:${stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file"}:${content}`);
    if (stat.isDirectory()) for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), relativePath.length === 0 ? entry : `${relativePath}/${entry}`);
  };
  await walk(root, "");
  return snapshot.sort();
}

async function assertNoStagingResidue(stagingRoot: string): Promise<void> {
  assert.equal((await readdir(stagingRoot)).some((entry) => entry.startsWith(".staging-")), false);
}

async function createByteDifferentCandidate(created: InstallFixture): Promise<{ archivePath: string; recordPath: string }> {
  const entries = readGzipUstar(await readFile(created.archivePath));
  const runtime = entries.find((entry) => entry.path === "harness/src/runtime.ts");
  const manifest = entries.find((entry) => entry.path === "release-manifest.json");
  if (runtime === undefined || manifest === undefined) throw new Error("fixture archive is incomplete");
  runtime.bytes = Buffer.concat([runtime.bytes, Buffer.from("// byte-different candidate\n")]);
  const rawManifest: unknown = JSON.parse(manifest.bytes.toString("utf8"));
  if (!recordValue(rawManifest) || !Array.isArray(rawManifest.files)) throw new Error("fixture manifest is invalid");
  const runtimeIntegrity = rawManifest.files.find((entry): entry is Record<string, unknown> =>
    recordValue(entry) && entry.path === runtime.path,
  );
  if (runtimeIntegrity === undefined) throw new Error("fixture runtime integrity is unavailable");
  runtimeIntegrity.byte_length = runtime.bytes.length;
  runtimeIntegrity.sha256 = createHash("sha256").update(runtime.bytes).digest("hex");
  manifest.bytes = Buffer.from(canonicalReleaseJson(rawManifest));

  const archivePath = join(dirname(created.archivePath), `different-${basename(created.archivePath)}`);
  await writeGzipUstar(entries, archivePath);
  const archive = await readFile(archivePath);
  const rawRecord: unknown = JSON.parse(await readFile(created.recordPath, "utf8"));
  if (!recordValue(rawRecord) || !recordValue(rawRecord.artifact_integrity) || !recordValue(rawRecord.artifact_integrity.archive) || !Array.isArray(rawRecord.verification_summary)) {
    throw new Error("fixture record is invalid");
  }
  rawRecord.artifact_integrity.archive.filename = basename(archivePath);
  rawRecord.artifact_integrity.archive.byte_length = archive.length;
  rawRecord.artifact_integrity.archive.sha256 = createHash("sha256").update(archive).digest("hex");
  const verification = rawRecord.verification_summary[0];
  if (!recordValue(verification)) throw new Error("fixture verification checksum is unavailable");
  verification.artifact_sha256 = rawRecord.artifact_integrity.archive.sha256;
  const recordPath = join(dirname(created.recordPath), "different-record.json");
  await writeFile(recordPath, canonicalReleaseJson(rawRecord), "utf8");
  return { archivePath, recordPath };
}

test("property: bootstrap installs and selects a release after the development checkout is unavailable", async () => {
  const created = await fixture(true);
  const bootstrapRoot = await mkdtemp(join(tmpdir(), "engram-release-bootstrap-"));
  try {
    const archivePath = join(bootstrapRoot, "artifacts", basename(created.archivePath));
    const recordPath = join(bootstrapRoot, "artifacts", basename(created.recordPath));
    const bootstrapPath = join(bootstrapRoot, "release", "engram-release.ts");
    await mkdir(dirname(archivePath), { recursive: true });
    await mkdir(dirname(bootstrapPath), { recursive: true });
    await Promise.all([
      copyFile(created.archivePath, archivePath),
      copyFile(created.recordPath, recordPath),
      copyFile(new URL("../../release/engram-release.ts", import.meta.url), bootstrapPath),
    ]);
    const sourceIndex = sources.indexOf(created.source);
    if (sourceIndex < 0) throw new Error("fixture checkout is not tracked");
    sources.splice(sourceIndex, 1);
    await rm(created.source.root, { recursive: true, force: true });
    const environment = {
      ...process.env,
      ENGRAM_RELEASE_HOME: created.root,
      ENGRAM_BIN_DIR: created.options.binDir,
    };
    const installed = await execFile(process.execPath, [bootstrapPath, "install", archivePath, recordPath], { env: environment });
    assert.equal(JSON.parse(installed.stdout).status, "installed");
    const selected = await execFile(process.execPath, [bootstrapPath, "select", created.releaseId], { env: environment });
    assert.equal(JSON.parse(selected.stdout).status, "selected");
    const binDir = created.options.binDir;
    if (binDir === undefined) throw new Error("fixture stable bin is unavailable");
    assert.equal(JSON.parse((await execFile(join(binDir, "engram"), ["version"])).stdout).release_id, created.releaseId);
  } finally {
    await rm(bootstrapRoot, { recursive: true, force: true });
  }
});

test("property: archive integrity is refused before staging or selection changes", async () => {
  const created = await fixture();
  await flipOneArchiveByte(created.archivePath);
  const result = await install(created);
  assert.equal(onlyReleaseErrorCode(result), "artifact_integrity_mismatch");
  assert.equal(await readCurrentId(created.options), null);
  await assert.rejects(readFile(join(created.stagingRoot, created.releaseId, "release-manifest.json")));
});

test("property: archive inventory contains every manifest file", async () => {
  const missing = await fixture();
  await removeArchiveEntry(missing, "harness/src/runtime.ts");
  assert.equal(onlyReleaseErrorCode(await install(missing)), "archive_inventory_mismatch");
  assert.equal(await readCurrentId(missing.options), null);
});

test("property: archive directory headers require mode 0755", async () => {
  const wrongDirectoryMode = await fixture();
  await rewriteArchiveDirectoryMode(wrongDirectoryMode, 0o700);
  assert.equal(onlyReleaseErrorCode(await install(wrongDirectoryMode)), "archive_inventory_mismatch");
  assert.equal(await readCurrentId(wrongDirectoryMode.options), null);
});

test("property: extracted archive directories are resilient to a restrictive umask", async () => {
  const created = await fixture();
  const previous = process.umask(0o077);
  try {
    const result = await install(created);
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally {
    process.umask(previous);
  }
});

test("property: archive entries cannot escape the staging directory", async () => {
  const archiveCases: Array<{ name: string; mutate: (archive: Buffer) => void }> = [
    { name: "absolute path", mutate: (archive) => { archive.fill(0, 0, 100); archive.write("/outside", 0, "ascii"); } },
    { name: "parent traversal", mutate: (archive) => { archive.fill(0, 0, 100); archive.write("../outside", 0, "ascii"); } },
    { name: "archive link", mutate: (archive) => { archive[156] = "2".charCodeAt(0); } },
  ];
  for (const archiveCase of archiveCases) {
    const created = await fixture();
    const sentinel = `${archiveCase.name}-sentinel`;
    await mkdir(created.root, { recursive: true });
    await writeFile(join(created.root, "outside-sentinel"), sentinel, "utf8");
    await rewriteArchiveHeader(created, archiveCase.mutate);
    await assertContainmentFailure(created, "archive_unsafe", sentinel);
  }

  for (const parent of ["release-home", "releases"]) {
    const created = await fixture();
    const sentinel = `${parent}-sentinel`;
    if (parent === "releases") {
      await mkdir(created.root, { recursive: true });
      await writeFile(join(created.root, "outside-sentinel"), sentinel, "utf8");
    }
    const outside = join(dirname(created.root), `outside-${parent}`);
    await mkdir(outside);
    const linkPath = parent === "release-home" ? created.root : join(created.root, "releases");
    if (parent === "releases") await mkdir(linkPath, { recursive: true });
    if (parent === "releases") await rm(linkPath, { recursive: true });
    await symlink(outside, linkPath);
    if (parent === "release-home") await writeFile(join(outside, "outside-sentinel"), sentinel, "utf8");
    // The outside directory must be byte-for-byte unchanged: a prevalidation
    // failure must reject the linked/outside root before writing any
    // descendant (e.g. an empty `releases`) into it.
    const beforeOutside = await treeSnapshot(outside);
    await assertContainmentFailure(created, "release_boundary_unsafe", sentinel);
    assert.deepEqual(await treeSnapshot(outside), beforeOutside);
  }
});

test("property: an installed release identifier is never replaced", async () => {
  const created = await fixture();
  assert.equal((await install(created)).ok, true);
  const installedTree = await treeSnapshot(join(created.root, "releases", created.releaseId));
  const selected = await readCurrentId(created.options);
  const different = await createByteDifferentCandidate(created);
  assert.notDeepEqual(await readFile(different.archivePath), await readFile(created.archivePath));

  const differentResult = await installRelease(different.archivePath, different.recordPath, created.options);
  assert.deepEqual(await treeSnapshot(join(created.root, "releases", created.releaseId)), installedTree);
  assert.equal(await readCurrentId(created.options), selected);
  await assertNoStagingResidue(created.stagingRoot);
  assert.equal(onlyReleaseErrorCode(differentResult), "release_exists");

  const identicalResult = await install(created);
  assert.deepEqual(await treeSnapshot(join(created.root, "releases", created.releaseId)), installedTree);
  assert.equal(await readCurrentId(created.options), selected);
  await assertNoStagingResidue(created.stagingRoot);
  assert.equal(onlyReleaseErrorCode(identicalResult), "release_exists");
});

test("property: concurrent installers cannot strand or remove shared launchers", async () => {
  const created = await fixture();
  const releaseGate = deferred();
  const continueGate = deferred();
  const first = installRelease(created.archivePath, created.recordPath, {
    ...managerOptions(created.options),
    hooks: {
      afterLaunchersInstalled: async () => {
        releaseGate.resolve();
        await continueGate.promise;
        throw new Error("synthetic post-launcher failure");
      },
    },
  });
  await releaseGate.promise;
  assert.equal(onlyReleaseErrorCode(await install(created)), "install_lock_conflict");
  continueGate.resolve();
  assert.equal(onlyReleaseErrorCode(await first), "install_failed");
  const binDir = created.options.binDir;
  if (binDir === undefined) throw new Error("fixture stable bin is unavailable");
  await assert.rejects(lstat(join(binDir, "engram")));
  await assert.rejects(lstat(join(binDir, "engram-release")));
  assert.equal((await install(created)).ok, true);
});

test("property: an empty unpublished install-lock directory is not permanent", async () => {
  const ownerless = await fixture();
  await mkdir(join(ownerless.stagingRoot, ".install-lock"), { recursive: true, mode: 0o700 });
  const result = await install(ownerless);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("property: a stale recovery marker whose same-host owner is dead is recovered", async () => {
  const staleRecovery = await fixture();
  const lockPath = join(staleRecovery.stagingRoot, ".install-lock");
  const deadOwner = { schema_version: 0, pid: process.pid + 1_000_000, hostname: hostname(), token: "dead-owner" };
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(join(lockPath, "owner.json"), JSON.stringify(deadOwner), "utf8");
  await writeFile(`${lockPath}.recovery`, JSON.stringify({ ...deadOwner, token: "dead-recovery", purpose: "recovery" }), "utf8");
  const result = await install(staleRecovery);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("property: a stale recovery marker with no lock directory is reclaimed before fresh acquisition", async () => {
  const noLockRecovery = await fixture();
  const lockPath = join(noLockRecovery.stagingRoot, ".install-lock");
  const deadRecovery = { schema_version: 0, pid: process.pid + 1_000_000, hostname: hostname(), token: "dead-recovery-no-lock", purpose: "recovery" };
  await mkdir(noLockRecovery.stagingRoot, { recursive: true, mode: 0o755 });
  await writeFile(`${lockPath}.recovery`, JSON.stringify(deadRecovery), "utf8");
  await assert.rejects(lstat(lockPath));
  const result = await install(noLockRecovery);
  assert.equal(result.ok, true, JSON.stringify(result));
  await assert.rejects(lstat(`${lockPath}.recovery`));
  await assert.rejects(lstat(lockPath));
});

test("property: an ownerless lock cannot be reclaimed while a fresh owner is publishing", async () => {
  const first = await fixture();
  const second = await fixture(true);
  const firstHome = first.options.releaseHome;
  const firstBin = first.options.binDir;
  if (firstHome === undefined || firstBin === undefined) throw new Error("fixture manager options are incomplete");
  const shared: ReleaseManagerOptions = { releaseHome: firstHome, binDir: firstBin };

  // A creates the lock directory and pauses right before publishing its
  // owner (via the exclusive hard-link). B then discovers the lock
  // ownerless, exclusively claims recovery of it, and pauses right after
  // winning that claim but before removing the lock. A resumes, publishes
  // its owner successfully, then must observe B's recovery claim and
  // token-clean its own owner/lock rather than returning acquired. B then
  // resumes, finds the lock vacated by A, retries, and acquires cleanly.
  let aPaused = false;
  const aAtPrePublish = deferred();
  const aResume = deferred();
  const aPromise = installRelease(first.archivePath, first.recordPath, {
    ...shared,
    hooks: {
      afterExistingOwnerRead: async () => {
        if (aPaused) return;
        aPaused = true;
        aAtPrePublish.resolve();
        await aResume.promise;
      },
    },
  });
  await aAtPrePublish.promise;

  let bPaused = false;
  const bAtClaimed = deferred();
  const bResume = deferred();
  const bPromise = installRelease(second.archivePath, second.recordPath, {
    ...shared,
    hooks: {
      afterExistingOwnerRead: async () => {
        if (bPaused) return;
        bPaused = true;
        bAtClaimed.resolve();
        await bResume.promise;
      },
    },
  });
  await bAtClaimed.promise;

  aResume.resolve();
  const aResult = await aPromise;
  bResume.resolve();
  const bResult = await bPromise;

  assert.equal(aResult.ok, false, JSON.stringify(aResult));
  assert.equal(onlyReleaseErrorCode(aResult), "install_lock_conflict");
  assert.equal(bResult.ok, true, JSON.stringify(bResult));
  assert.equal(await readCurrentId(shared), second.releaseId);

  const lockPath = join(firstHome, "releases", ".install-lock");
  await assert.rejects(lstat(lockPath));
  await assert.rejects(lstat(`${lockPath}.recovery`));
  assert.equal((await installRelease(first.archivePath, first.recordPath, shared)).ok, true);
});

test("property: a fresh owner never reports acquired after a recoverer removes its lock and clears its marker", async () => {
  const first = await fixture();
  const second = await fixture(true);
  const firstHome = first.options.releaseHome;
  const firstBin = first.options.binDir;
  if (firstHome === undefined || firstBin === undefined) throw new Error("fixture manager options are incomplete");
  const shared: ReleaseManagerOptions = { releaseHome: firstHome, binDir: firstBin };

  // A creates the lock (generation 1) and pauses right before publishing its
  // owner. B then discovers the lock ownerless, exclusively claims recovery
  // of it, rechecks it still ownerless (A has not published yet), and
  // pauses right after that recheck but before removing the lock. A resumes
  // and publishes its owner into generation 1 successfully, then pauses
  // again immediately after publishing but before checking for a recovery
  // claim. B resumes: it removes generation 1 (owner.json and all) and
  // clears its own recovery marker, retries, creates generation 2, publishes
  // its own owner into it, and pauses again right after that publish. Only
  // then does A resume: its recovery-marker check is now clean (B already
  // cleared it), so A must re-read owner.json and lstat the lock directory
  // before ever reporting acquired -- and must not, because generation 1 is
  // gone and the path now names B's generation 2 with B's token. A's own
  // retry then correctly observes B's live owner and reports a conflict. B
  // then resumes past its own check, finds nothing wrong, and completes its
  // own install normally.
  let aCalls = 0;
  const aAtMkdir = deferred();
  const aResumeMkdir = deferred();
  const aAtPublish = deferred();
  const aResumePublish = deferred();
  const aPromise = installRelease(first.archivePath, first.recordPath, {
    ...shared,
    hooks: {
      afterExistingOwnerRead: async () => {
        aCalls += 1;
        if (aCalls === 1) {
          aAtMkdir.resolve();
          await aResumeMkdir.promise;
          return;
        }
        if (aCalls === 2) {
          aAtPublish.resolve();
          await aResumePublish.promise;
        }
      },
    },
  });
  await aAtMkdir.promise;

  let bCalls = 0;
  const bAtRecheck = deferred();
  const bResumeRecheck = deferred();
  const bAtPublish = deferred();
  const bResumePublish = deferred();
  const bPromise = installRelease(second.archivePath, second.recordPath, {
    ...shared,
    hooks: {
      afterExistingOwnerRead: async () => {
        bCalls += 1;
        if (bCalls === 2) {
          bAtRecheck.resolve();
          await bResumeRecheck.promise;
          return;
        }
        if (bCalls === 4) {
          bAtPublish.resolve();
          await bResumePublish.promise;
        }
      },
    },
  });
  await bAtRecheck.promise;

  aResumeMkdir.resolve();
  await aAtPublish.promise;

  bResumeRecheck.resolve();
  await bAtPublish.promise;

  aResumePublish.resolve();
  const aResult = await aPromise;

  bResumePublish.resolve();
  const bResult = await bPromise;

  assert.equal(aResult.ok, false, JSON.stringify(aResult));
  assert.equal(onlyReleaseErrorCode(aResult), "install_lock_conflict");
  assert.equal(bResult.ok, true, JSON.stringify(bResult));
  assert.equal(await readCurrentId(shared), second.releaseId);

  const lockPath = join(firstHome, "releases", ".install-lock");
  await assert.rejects(lstat(lockPath));
  await assert.rejects(lstat(`${lockPath}.recovery`));
  assert.equal((await installRelease(first.archivePath, first.recordPath, shared)).ok, true);
});

test("property: one stable engram command executes the currently selected release", async () => {
  const first = await fixture(true);
  const second = await fixture(true);
  const firstHome = first.options.releaseHome;
  const firstBin = first.options.binDir;
  if (firstHome === undefined || firstBin === undefined) throw new Error("fixture manager options are incomplete");
  const shared: ReleaseManagerOptions = { releaseHome: firstHome, binDir: firstBin };
  assert.equal((await installRelease(first.archivePath, first.recordPath, shared)).ok, true);
  assert.equal((await installRelease(second.archivePath, second.recordPath, shared)).ok, true);
  const launcher = join(firstBin, "engram");
  await selectRelease(first.releaseId, shared);
  assert.equal(JSON.parse((await execFile(launcher, ["version"])).stdout).release_id, first.releaseId);
  await selectRelease(second.releaseId, shared);
  assert.equal(JSON.parse((await execFile(launcher, ["version"])).stdout).release_id, second.releaseId);
});

test("property: the installed stable engram launcher needs no external POSIX utility beyond node", async () => {
  const created = await fixtureWithRealLauncher();
  const sessionId = "r0-minimal-path-session";
  const spaceId = "r0-minimal-path-space";
  await mkdir(created.root, { recursive: true });
  const registryPath = join(created.root, "space-registry.json");
  await writeFile(
    registryPath,
    JSON.stringify({ schema_version: 0, spaces: [{ space_id: spaceId }], active: { [sessionId]: spaceId }, last_boundary_error: null }),
    "utf8",
  );
  assert.equal((await install(created)).ok, true);
  const binDir = created.options.binDir;
  if (binDir === undefined) throw new Error("fixture stable bin is unavailable");
  const home = join(created.root, "minimal-home");
  const temporary = join(created.root, "minimal-tmp");
  await mkdir(home, { recursive: true });
  await mkdir(temporary, { recursive: true });
  // Exactly the scoped smoke environment the qualification orchestrator
  // builds (smokeEnv in harness/scripts/release.ts): PATH holds only the
  // running node's bin directory, HOME/TMPDIR are scoped, and no other
  // ambient variable survives. dirname/basename/readlink are unreachable,
  // so the packaged bin/engram must derive its release root with pure shell.
  const environment = {
    PATH: dirname(process.execPath),
    HOME: home,
    TMPDIR: temporary,
    ENGRAM_BINDING_REGISTRY: registryPath,
    ENGRAM_HOST_SESSION_ID: sessionId,
  };
  const projection: unknown = JSON.parse((await execFile(join(binDir, "engram"), ["space", "status"], { env: environment })).stdout);
  assert.deepEqual(projection, {
    schema_version: 0,
    registered_spaces: [spaceId],
    active_spaces: { [sessionId]: { space_id: spaceId } },
    last_boundary_error: null,
    // The launcher must resolve the `current` symlink to the physical
    // release directory (pwd -P semantics), never the link path.
    physical_dir: await realpath(join(created.root, "releases", created.releaseId, "harness", "src")),
  });
});
test("property: selecting a release changes only current", async () => {
  const first = await fixture();
  const second = await fixture(true);
  const home = first.options.releaseHome;
  const bin = first.options.binDir;
  if (home === undefined || bin === undefined) throw new Error("fixture paths are unavailable");
  const options = { releaseHome: home, binDir: bin };
  assert.equal((await installRelease(first.archivePath, first.recordPath, options)).ok, true);
  assert.equal((await installRelease(second.archivePath, second.recordPath, options)).ok, true);
  const unrelated = join(first.root, "unrelated-state");
  await writeFile(unrelated, "fictional unrelated state", "utf8");
  const releases = join(home, "releases");
  const beforeA = await treeSnapshot(join(releases, first.releaseId));
  const beforeB = await treeSnapshot(join(releases, second.releaseId));
  const unrelatedSnapshot = await treeSnapshot(unrelated);
  assert.equal((await selectRelease(second.releaseId, options)).ok, true);
  assert.deepEqual(await treeSnapshot(join(releases, first.releaseId)), beforeA);
  assert.deepEqual(await treeSnapshot(join(releases, second.releaseId)), beforeB);
  assert.deepEqual(await treeSnapshot(unrelated), unrelatedSnapshot);
  assert.equal(await readCurrentId(options), second.releaseId);

  const realReleases = join(home, ".real-releases");
  await rename(releases, realReleases);
  await symlink(".real-releases", releases);
  try {
    assert.equal(onlyReleaseErrorCode(await selectRelease(first.releaseId, options)), "release_boundary_unsafe");
    assert.equal(await readCurrentId(options), second.releaseId);
    assert.deepEqual(await treeSnapshot(join(realReleases, first.releaseId)), beforeA);
    assert.deepEqual(await treeSnapshot(join(realReleases, second.releaseId)), beforeB);
    assert.deepEqual(await treeSnapshot(unrelated), unrelatedSnapshot);
  } finally {
    await unlink(releases);
    await rename(realReleases, releases);
  }

  const linkedId = "r0-0000000000000000000000000000000000000001";
  await symlink(first.releaseId, join(releases, linkedId));
  assert.equal(onlyReleaseErrorCode(await selectRelease(linkedId, options)), "selection_target_linked");
  assert.equal(await readCurrentId(options), second.releaseId);
  assert.deepEqual(await treeSnapshot(join(releases, first.releaseId)), beforeA);
  assert.deepEqual(await treeSnapshot(join(releases, second.releaseId)), beforeB);
  assert.deepEqual(await treeSnapshot(unrelated), unrelatedSnapshot);
});

test("property: rollback reselects the previous immutable release", async () => {
  const first = await fixture();
  const second = await fixture(true);
  const firstHome = first.options.releaseHome;
  const firstBin = first.options.binDir;
  if (firstHome === undefined || firstBin === undefined) throw new Error("fixture manager options are incomplete");
  const shared: ReleaseManagerOptions = { releaseHome: firstHome, binDir: firstBin };
  assert.equal((await installRelease(first.archivePath, first.recordPath, shared)).ok, true);
  assert.equal((await installRelease(second.archivePath, second.recordPath, shared)).ok, true);
  assert.equal((await selectRelease(first.releaseId, shared)).ok, true);
  assert.equal((await selectRelease(second.releaseId, shared)).ok, true);
  assert.equal((await selectRelease(first.releaseId, shared)).ok, true);
  assert.equal(await readCurrentId(shared), first.releaseId);
});

test("property: failed install and selection leave the active release runnable", async () => {
  const created = await fixture(true);
  assert.equal((await install(created)).ok, true);
  const binDir = created.options.binDir;
  if (binDir === undefined) throw new Error("fixture stable bin is unavailable");
  const launcher = join(binDir, "engram");
  assert.equal(JSON.parse((await execFile(launcher, ["version"])).stdout).release_id, created.releaseId);
  await flipOneArchiveByte(created.archivePath);
  assert.equal(onlyReleaseErrorCode(await install(created)), "artifact_integrity_mismatch");
  assert.equal(JSON.parse((await execFile(launcher, ["version"])).stdout).release_id, created.releaseId);
  const selected = await selectRelease("r0-0000000000000000000000000000000000000000", created.options);
  assert.equal(selected.ok, false);
  assert.equal(JSON.parse((await execFile(launcher, ["version"])).stdout).release_id, created.releaseId);
});

test("property: dangling current and substituted targets refuse selection without changing current", async () => {
  const created = await fixture();
  assert.equal((await install(created)).ok, true);
  const home = created.options.releaseHome;
  if (home === undefined) throw new Error("fixture release home is unavailable");
  await unlink(join(home, "current"));
  await symlink("releases/r0-0000000000000000000000000000000000000000", join(home, "current"));
  assert.equal(onlyReleaseErrorCode(await currentRelease(created.options)), "current_absent");

  const replacement = await fixture();
  assert.equal((await install(replacement)).ok, true);
  const replacementHome = replacement.options.releaseHome;
  if (replacementHome === undefined) throw new Error("replacement release home is unavailable");
  const outside = join(dirname(replacementHome), "selection-outside");
  await mkdir(outside);
  const selected = await selectRelease(replacement.releaseId, {
    ...managerOptions(replacement.options),
    hooks: {
      beforeSelectionRename: async () => {
        const target = join(replacementHome, "releases", replacement.releaseId);
        await chmod(target, 0o755);
        await rename(target, join(replacementHome, "releases", ".substituted"));
        await symlink(outside, target);
      },
    },
  });
  assert.equal(onlyReleaseErrorCode(selected), "selection_target_linked");
  assert.equal(await readCurrentId(replacement.options), replacement.releaseId);
});


test("property: final release publication never replaces a post-launcher raced-in directory", async () => {
  const created = await fixture();
  const home = created.options.releaseHome;
  const binDir = created.options.binDir;
  if (home === undefined || binDir === undefined) throw new Error("fixture paths are unavailable");
  const finalPath = join(home, "releases", created.releaseId);
  const result = await installRelease(created.archivePath, created.recordPath, {
    ...managerOptions(created.options),
    hooks: { afterLaunchersInstalled: async () => { await mkdir(finalPath); } },
  });
  assert.equal(onlyReleaseErrorCode(result), "release_exists");
  assert.equal((await lstat(finalPath)).isDirectory(), true);
  assert.equal(await readCurrentId(created.options), null);
  await assert.rejects(lstat(join(binDir, "engram")));
  assert.equal((await readdir(join(home, "releases"))).some((name) => name.startsWith(".staging-")), false);
});
test("property: release artifacts and manager output contain no neighboring runtime state — manager projection", async () => {
  const created = await fixture();
  const sentinel = "FICTIONAL-PRIVATE-SENTINEL";
  const rawRecord: unknown = JSON.parse(await readFile(created.recordPath, "utf8"));
  if (!recordValue(rawRecord)) throw new Error("fixture record is invalid");
  rawRecord.source_revision = sentinel;
  const badRecordPath = join(created.root, "bad-record.json");
  await mkdir(created.root, { recursive: true });
  await writeFile(badRecordPath, JSON.stringify(rawRecord), "utf8");
  const listed: string[] = [];
  const current: string[] = [];
  const failed: string[] = [];
  const listedCode = await runReleaseManager(["list"], { ...managerOptions(created.options), stdout: (line) => listed.push(line) });
  const currentCode = await runReleaseManager(["current"], { ...managerOptions(created.options), stdout: (line) => current.push(line) });
  const failedCode = await runReleaseManager(
    ["install", created.archivePath, badRecordPath],
    { ...managerOptions(created.options), stdout: (line) => failed.push(line) },
  );
  assert.equal(listedCode, 0);
  assert.equal(currentCode, 0);
  assert.equal(failedCode, 1);
  const listedPayload: unknown = JSON.parse(listed.join(""));
  const currentPayload: unknown = JSON.parse(current.join(""));
  const failedPayload: unknown = JSON.parse(failed.join(""));
  if (
    !recordValue(listedPayload) ||
    !recordValue(currentPayload) ||
    !recordValue(failedPayload) ||
    !Array.isArray(failedPayload.errors)
  ) throw new Error("manager projection is invalid");
  const firstError = failedPayload.errors[0];
  if (!recordValue(firstError)) throw new Error("manager error projection is invalid");
  assert.deepEqual(Object.keys(listedPayload).sort(), ["release_ids", "schema_version", "selected_release_id", "status"]);
  assert.deepEqual(Object.keys(currentPayload).sort(), ["release_id", "schema_version", "status"]);
  assert.equal(firstError.code, "release_record_invalid");
  for (const output of [listed.join(""), current.join(""), failed.join("")]) {
    assert.equal(output.includes(sentinel), false);
    assert.equal(output.includes(created.root), false);
  }
});

// Default release paths are derived from an injected HOME value only: every
// install in these tests runs against temporary directories under tmpdir(),
// never the real user home. os.homedir() reads process.env.HOME reactively,
// which is the seam the XDG-style default derivations are asserted through.
function scopedInstallEnvironment(overrides: Record<string, string | undefined>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const key of ["HOME", "ENGRAM_RELEASE_HOME", "ENGRAM_BIN_DIR"]) {
    previous[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// mkdtemp under tmpdir() returns a /var-framed path, but the manager resolves
// the release home through realpath (which canonicalizes to /private/var);
// asserting against this canonical form keeps the expected paths byte-equal to
// what the manager derives and embeds in launcher content.
async function temporaryCanonicalHome(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

test("property: without overrides the release home defaults to ~/.local/share/engram and launchers to ~/.local/bin independently", async () => {
  const created = await fixture();
  const homeA = await temporaryCanonicalHome("engram-default-home-a-");
  const restore = scopedInstallEnvironment({ HOME: homeA, ENGRAM_RELEASE_HOME: undefined, ENGRAM_BIN_DIR: undefined });
  try {
    const result = await installRelease(created.archivePath, created.recordPath, {});
    assert.equal(result.ok, true, JSON.stringify(result));
    const releaseHomeA = join(homeA, ".local", "share", "engram");
    const binDirA = join(homeA, ".local", "bin");
    assert.equal((await lstat(join(releaseHomeA, "releases", created.releaseId))).isDirectory(), true);
    assert.equal(await readlink(join(releaseHomeA, "current")), `releases/${created.releaseId}`);
    const engramLauncherA = await readFile(join(binDirA, "engram"), "utf8");
    assert.equal(engramLauncherA.includes(join(releaseHomeA, "current", "bin", "engram")), true);

    // A custom ENGRAM_RELEASE_HOME alone must not move launchers under it: the
    // launcher directory is derived from the home root, not the release home.
    const homeB = await temporaryCanonicalHome("engram-default-home-b-");
    const customReleaseHome = await temporaryCanonicalHome("engram-custom-release-home-");
    const secondary = scopedInstallEnvironment({ HOME: homeB, ENGRAM_RELEASE_HOME: customReleaseHome, ENGRAM_BIN_DIR: undefined });
    try {
      const customResult = await installRelease(created.archivePath, created.recordPath, {});
      assert.equal(customResult.ok, true, JSON.stringify(customResult));
      assert.equal((await lstat(join(customReleaseHome, "releases", created.releaseId))).isDirectory(), true);
      assert.equal((await lstat(join(homeB, ".local", "bin", "engram"))).isFile(), true);
      const independentLauncher = await readFile(join(homeB, ".local", "bin", "engram"), "utf8");
      assert.equal(independentLauncher.includes(join(customReleaseHome, "current", "bin", "engram")), true);
      await assert.rejects(lstat(join(customReleaseHome, "bin")));
    } finally {
      secondary();
    }
  } finally {
    restore();
  }
});

test("property: explicit options beat environment variables which beat defaults for both release paths", async () => {
  const created = await fixture();
  const homeEnv = await temporaryCanonicalHome("engram-precedence-home-");
  const envHome = join(await temporaryCanonicalHome("engram-precedence-env-"), "env-release-home");
  const envBin = join(await temporaryCanonicalHome("engram-precedence-env-"), "env-bin");
  const restore = scopedInstallEnvironment({ HOME: homeEnv, ENGRAM_RELEASE_HOME: envHome, ENGRAM_BIN_DIR: envBin });
  try {
    // Neither path is overridden: both environment variables beat the defaults.
    const envOnly = await installRelease(created.archivePath, created.recordPath, {});
    assert.equal(envOnly.ok, true, JSON.stringify(envOnly));
    assert.equal((await lstat(join(envHome, "releases", created.releaseId))).isDirectory(), true);
    assert.equal((await lstat(join(envBin, "engram"))).isFile(), true);
    assert.equal((await readFile(join(envBin, "engram"), "utf8")).includes(join(envHome, "current", "bin", "engram")), true);
    assert.equal((await readdir(homeEnv)).includes(".local"), false);

    // Both paths explicitly set: options beat the conflicting environment values.
    const optHome = join(await temporaryCanonicalHome("engram-precedence-opt-"), "opt-release-home");
    const optBin = join(await temporaryCanonicalHome("engram-precedence-opt-"), "opt-bin");
    const optionOnly = await installRelease(created.archivePath, created.recordPath, { releaseHome: optHome, binDir: optBin });
    assert.equal(optionOnly.ok, true, JSON.stringify(optionOnly));
    assert.equal((await lstat(join(optHome, "releases", created.releaseId))).isDirectory(), true);
    assert.equal((await lstat(join(optBin, "engram"))).isFile(), true);
    assert.equal((await readFile(join(optBin, "engram"), "utf8")).includes(join(optHome, "current", "bin", "engram")), true);

    // Only releaseHome is overridden: options beat the environment for that
    // path, and the unoverridden binDir falls back to the default derived
    // from the home root — never under the option-sourced release home.
    const homeDefaultBin = await temporaryCanonicalHome("engram-precedence-home-");
    const envHomeSide = join(await temporaryCanonicalHome("engram-precedence-env-"), "env-release-home-side");
    const optHomeSide = join(await temporaryCanonicalHome("engram-precedence-opt-"), "opt-release-home-side");
    const sideways = scopedInstallEnvironment({ HOME: homeDefaultBin, ENGRAM_RELEASE_HOME: envHomeSide, ENGRAM_BIN_DIR: undefined });
    try {
      const sideResult = await installRelease(created.archivePath, created.recordPath, { releaseHome: optHomeSide });
      assert.equal(sideResult.ok, true, JSON.stringify(sideResult));
      assert.equal((await lstat(join(optHomeSide, "releases", created.releaseId))).isDirectory(), true);
      assert.equal((await lstat(join(homeDefaultBin, ".local", "bin", "engram"))).isFile(), true);
      assert.equal((await readFile(join(homeDefaultBin, ".local", "bin", "engram"), "utf8")).includes(join(optHomeSide, "current", "bin", "engram")), true);
      await assert.rejects(lstat(join(optHomeSide, "bin")));
    } finally {
      sideways();
    }

    // Only binDir is overridden: options beat the environment for that path,
    // and the unoverridden releaseHome still resolves from the environment.
    const envHomeMirror = join(await temporaryCanonicalHome("engram-precedence-env-"), "env-release-home-mirror");
    const envBinMirror = join(await temporaryCanonicalHome("engram-precedence-env-"), "env-bin-mirror");
    const optBinMirror = join(await temporaryCanonicalHome("engram-precedence-opt-"), "opt-bin-mirror");
    const mirrored = scopedInstallEnvironment({ HOME: homeEnv, ENGRAM_RELEASE_HOME: envHomeMirror, ENGRAM_BIN_DIR: envBinMirror });
    try {
      const mirrorResult = await installRelease(created.archivePath, created.recordPath, { binDir: optBinMirror });
      assert.equal(mirrorResult.ok, true, JSON.stringify(mirrorResult));
      assert.equal((await lstat(join(envHomeMirror, "releases", created.releaseId))).isDirectory(), true);
      assert.equal((await lstat(join(optBinMirror, "engram"))).isFile(), true);
      assert.equal((await readFile(join(optBinMirror, "engram"), "utf8")).includes(join(envHomeMirror, "current", "bin", "engram")), true);
    } finally {
      mirrored();
    }
  } finally {
    restore();
  }
});
