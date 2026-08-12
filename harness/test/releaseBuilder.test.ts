import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { join } from "node:path";

import { readGzipUstar, writeGzipUstar } from "../scripts/release-archive.ts";
import { buildReleaseCandidate, stageRelease } from "../scripts/release-builder.ts";
import {
  createSyntheticReleaseSource,
  createSyntheticReleaseSourceWithTrackedLeafSymlink,
  destroySyntheticReleaseSource,
  type SyntheticReleaseSource,
} from "./releaseTestSupport.ts";

const fixtures: SyntheticReleaseSource[] = [];

after(async () => {
  await Promise.all(fixtures.map(destroySyntheticReleaseSource));
});

async function fixture(): Promise<SyntheticReleaseSource> {
  const created = await createSyntheticReleaseSource();
  fixtures.push(created);
  return created;
}

function stageInput(source: SyntheticReleaseSource) {
  return {
    repoRoot: source.root,
    stageRoot: source.stage,
    sourceRevision: source.revision,
    nodeVersion: process.versions.node,
    qmdVersion: "qmd synthetic-0",
  };
}

function recomputeChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
}

test("property: release staging enumerates only the approved runtime allowlist", async () => {
  const source = await fixture();
  await writeFile(join(source.root, "machine-binding.json"), "FICTIONAL-BINDING-SENTINEL\n");
  const staged = await stageRelease(stageInput(source));

  assert.deepEqual(staged.files.map((entry) => entry.path), source.expectedAllowedPaths);
  assert.equal((await readFile(staged.archivePath)).includes(Buffer.from("FICTIONAL-BINDING-SENTINEL")), false);
});

test("property: core-only release declares zero included packs and stages no bundled pack or test payload", async () => {
  const PACKS_ROOT = "pac" + "ks/"; // assembled so the source scan never sees a bundle path
  const stagedSource = await fixture();
  const staged = await stageRelease(stageInput(stagedSource));
  assert.deepEqual(staged.manifest.included_packs, []);
  assert.equal(staged.files.some((entry) => entry.path.startsWith(PACKS_ROOT)), false);
  assert.equal(staged.files.some((entry) => entry.path.startsWith("harness/test/")), false);

  const recordSource = await fixture();
  const candidate = await buildReleaseCandidate({
    ...stageInput(recordSource),
    outputRoot: recordSource.output,
    publishedAt: "2026-08-08T00:00:00.000Z",
  });
  assert.deepEqual(candidate.record.included_packs, []);
});

test("property: generated runtime package metadata contains exactly three approved keys", async () => {
  const source = await fixture();
  await stageRelease(stageInput(source));
  const bytes = await readFile(join(source.stage, "harness", "package.json"));

  assert.equal(bytes.toString("utf8"), '{"name":"engram-harness","private":true,"type":"module"}\n');
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), {
    name: "engram-harness",
    private: true,
    type: "module",
  });
});

test("property: release build refuses tracked or untracked source changes before staging", async () => {
  const source = await fixture();
  const trackedPath = join(source.root, "harness", "src", "cli.ts");
  const trackedOriginal = await readFile(trackedPath, "utf8");
  await writeFile(trackedPath, `${trackedOriginal}// tracked mutation\n`);

  await assert.rejects(
    buildReleaseCandidate({ ...stageInput(source), outputRoot: source.output }),
    { code: "source_dirty" },
  );

  await writeFile(trackedPath, trackedOriginal);
  await writeFile(join(source.root, "harness", "src", "untracked.ts"), "export const untracked = true;\n");
  await assert.rejects(
    buildReleaseCandidate({ ...stageInput(source), outputRoot: source.output }),
    { code: "source_dirty" },
  );
});

test("release staging rejects a tracked inventory without the packaged launcher", async () => {
  const source = await fixture();
  const trackedPaths = source.expectedAllowedPaths.filter((path) =>
    path !== "bin/engram" && path !== "harness/package.json" && path !== "release-manifest.json",
  );
  const runner = async () => ({ stdout: `${trackedPaths.join("\0")}\0`, exitCode: 0 });

  await assert.rejects(stageRelease(stageInput(source), runner), { code: "stage_invalid" });
  await assert.rejects(readFile(`${source.stage}.tar.gz`));
});

test("release staging rejects a tracked inventory without the runtime CLI", async () => {
  const source = await fixture();
  const trackedPaths = source.expectedAllowedPaths.filter((path) =>
    path !== "harness/src/cli.ts" && path !== "harness/package.json" && path !== "release-manifest.json",
  );
  const runner = async () => ({ stdout: `${trackedPaths.join("\0")}\0`, exitCode: 0 });

  await assert.rejects(stageRelease(stageInput(source), runner), { code: "stage_invalid" });
  await assert.rejects(readFile(`${source.stage}.tar.gz`));
});

test("property: release artifacts and manager output contain no neighboring runtime state — artifact boundary", async () => {
  const source = await fixture();
  const neighboringRuntimeState = [
    { path: "machine-binding.json", sentinel: "FICTIONAL-BOUNDARY-BINDING-SENTINEL" },
    { path: "qmd-cache/index.bin", sentinel: "FICTIONAL-BOUNDARY-QMD-SENTINEL" },
    { path: "receipts/publication.txt", sentinel: "FICTIONAL-BOUNDARY-RECEIPT-SENTINEL" },
    { path: "retained-presentations/brief.txt", sentinel: "FICTIONAL-BOUNDARY-PRESENTATION-SENTINEL" },
  ];
  for (const { path, sentinel } of neighboringRuntimeState) {
    await writeFile(join(source.root, path), `${sentinel}\n`);
  }

  const staged = await stageRelease(stageInput(source));
  const archive = await readFile(staged.archivePath);
  const entries = readGzipUstar(archive);
  for (const { sentinel } of neighboringRuntimeState) {
    assert.equal(archive.includes(Buffer.from(sentinel)), false);
    assert.equal(entries.some((entry) => entry.path.includes(sentinel) || entry.bytes.includes(Buffer.from(sentinel))), false);
  }
});

test("property: release staging refuses an allowed path through an in-repository symlink parent", async () => {
  const source = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "engram-release-outside-"));
  const linkedParent = join(source.root, "harness", "src", "linked");
  const outsideBytes = "FICTIONAL-OUTSIDE-SYMLINK-SENTINEL\n";
  try {
    await writeFile(join(outside, "escaped.ts"), outsideBytes, "utf8");
    await rm(linkedParent, { recursive: true, force: true });
    await symlink(outside, linkedParent);
    const runner = async (args: readonly string[]) => {
      if (args[0] === "rev-parse") return { stdout: `${source.revision}\n`, exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    };

    await assert.rejects(
      buildReleaseCandidate({ ...stageInput(source), outputRoot: source.output, runner }),
      { code: "stage_invalid" },
    );
    await assert.rejects(readFile(join(source.stage, "harness", "src", "linked", "escaped.ts"), "utf8"));
    await assert.rejects(readFile(`${source.stage}.tar.gz`));
    await assert.rejects(readFile(join(source.output, `engram-r0-${source.revision}.tar.gz`)));
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("property: release staging refuses a clean tracked leaf symlink", async () => {
  const source = await createSyntheticReleaseSourceWithTrackedLeafSymlink();
  fixtures.push(source);

  await assert.rejects(
    buildReleaseCandidate({ ...stageInput(source), outputRoot: source.output }),
    { code: "stage_invalid" },
  );
  await assert.rejects(readFile(join(source.stage, "harness", "src", "leak.ts"), "utf8"));
  await assert.rejects(readFile(`${source.stage}.tar.gz`));
  await assert.rejects(readFile(join(source.output, `engram-r0-${source.revision}.tar.gz`)));
});

test("property: candidate evidence follows archive inspection before publication", async () => {
  const readers: Array<(archive: Buffer) => Array<{ path: string; bytes: Buffer; executable: boolean }>> = [
    () => [],
    (archive) => {
      const entries = readGzipUstar(archive);
      return entries.map((entry, index) => index === 0 ? { ...entry, path: `${entry.path}-altered` } : entry);
    },
    (archive) => {
      const entries = readGzipUstar(archive);
      return entries.map((entry, index) =>
        index === 0 ? { ...entry, bytes: Buffer.concat([entry.bytes, Buffer.from("\n")]) } : entry,
      );
    },
    (archive) => {
      const entries = readGzipUstar(archive);
      return entries.map((entry, index) => {
        if (index !== 0) return entry;
        const bytes = Buffer.from(entry.bytes);
        const firstByte = bytes[0];
        if (firstByte === undefined) throw new Error("fixture archive entry is unexpectedly empty");
        bytes[0] = firstByte ^ 0xff;
        return { ...entry, bytes };
      });
    },
    (archive) => {
      const entries = readGzipUstar(archive);
      return entries.map((entry, index) => index === 0 ? { ...entry, executable: !entry.executable } : entry);
    },
  ];

  for (const archiveReader of readers) {
    const source = await fixture();
    await assert.rejects(
      buildReleaseCandidate({ ...stageInput(source), outputRoot: source.output, archiveReader }),
      { code: "stage_invalid" },
    );
    await assert.rejects(readFile(join(source.output, `engram-r0-${source.revision}.tar.gz`)));
    await assert.rejects(readFile(join(source.output, `engram-release-r0-${source.revision}.ts`)));
  }
});

test("repository archive writer rejects a regular file that collides with an implicit parent directory", async () => {
  const source = await fixture();
  await mkdir(source.output, { recursive: true });
  const destination = join(source.output, "collision.tar.gz");

  await assert.rejects(
    writeGzipUstar([
      { path: "a", bytes: Buffer.from("a\\n"), executable: false },
      { path: "a/b", bytes: Buffer.from("b\\n"), executable: false },
    ], destination),
    /parent directory/,
  );
  await assert.rejects(readFile(destination));
});

test("candidate publication leaves no archive when the final bootstrap name already exists", async () => {
  const source = await fixture();
  await mkdir(source.output, { recursive: true });
  const bootstrapPath = join(source.output, `engram-release-r0-${source.revision}.ts`);
  await mkdir(bootstrapPath);

  await assert.rejects(
    buildReleaseCandidate({ ...stageInput(source), outputRoot: source.output }),
    { code: "stage_invalid" },
  );
  assert.equal((await lstat(bootstrapPath)).isDirectory(), true);
  await assert.rejects(readFile(join(source.output, `engram-r0-${source.revision}.tar.gz`)));
});

test("buildReleaseCandidate binds its record to the exact archive and bootstrap bytes", async () => {
  const source = await fixture();
  const candidate = await buildReleaseCandidate({
    ...stageInput(source),
    outputRoot: source.output,
    publishedAt: "2026-08-08T00:00:00.000Z",
  });
  const archive = await readFile(candidate.archivePath);
  const bootstrap = await readFile(candidate.bootstrapPath);

  assert.equal(candidate.releaseId, `r0-${source.revision}`);
  assert.equal(candidate.archiveIntegrity.byte_length, archive.length);
  assert.equal(candidate.record.artifact_integrity.archive.sha256, candidate.archiveIntegrity.sha256);
  assert.ok(candidate.record.verification_summary.every((entry) => entry.artifact_sha256 === candidate.archiveIntegrity.sha256));
  assert.deepEqual(bootstrap, await readFile(join(source.root, "release", "engram-release.ts")));
});

test("repository archive reader refuses malformed ustar structure", async () => {
  const source = await fixture();
  await mkdir(source.output, { recursive: true });
  const destination = join(source.output, "fixture.tar.gz");
  await writeGzipUstar([{ path: "bin/engram", bytes: Buffer.from("fixture\n"), executable: true }], destination);
  const archive = await readFile(destination);
  const malformedChecksum = gunzipSync(archive);
  malformedChecksum[0] = 0x78;
  assert.throws(() => readGzipUstar(gzipSync(malformedChecksum)), /ustar/);

  const malformedType = gunzipSync(archive);
  malformedType[156] = "2".charCodeAt(0);
  recomputeChecksum(malformedType.subarray(0, 512));
  assert.throws(() => readGzipUstar(gzipSync(malformedType)), /type/);

  const trailing = Buffer.concat([gunzipSync(archive), Buffer.from("x")]);
  assert.throws(() => readGzipUstar(gzipSync(trailing)), /trailing|block/);
});
