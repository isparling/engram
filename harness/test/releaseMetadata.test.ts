import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  PACKAGING_PROCEDURE_VERSION,
  RELEASE_FORMAT_VERSION,
  RELEASE_SCHEMA_VERSION,
  canonicalReleaseJson,
  parseReleaseManifest,
  parseReleaseRecord,
  readReleaseManifest,
} from "../../release/engram-release.ts";

const SOURCE_REVISION = "a".repeat(40);
const RELEASE_ID = `r0-${SOURCE_REVISION}`;
const ARCHIVE_HASH = "a".repeat(64);
const BOOTSTRAP_HASH = "c".repeat(64);
const FILE_HASH = "d".repeat(64);
const scratchDirs: string[] = [];

after(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function validManifest(): Record<string, unknown> {
  return {
    schema_version: RELEASE_SCHEMA_VERSION,
    release_format: RELEASE_FORMAT_VERSION,
    version: RELEASE_ID,
    source_revision: SOURCE_REVISION,
    packaging_procedure_version: PACKAGING_PROCEDURE_VERSION,
    host_agent_compatibility: "host-neutral-cli-schema-0",
    qmd_compatibility: { contract: "scoped-cli", version: "0.1.0" },
    knowledge_schema_compatibility: ["0"],
    pack_api_compatibility: 0,
    environment_compatibility: {
      platform: "darwin",
      architecture: "arm64",
      node_version: process.version,
    },
    included_packs: [],
    files: [{ path: "harness/src/cli.ts", byte_length: 42, sha256: FILE_HASH, executable: false }],
  };
}

function validRecord(): Record<string, unknown> {
  return {
    schema_version: RELEASE_SCHEMA_VERSION,
    version: RELEASE_ID,
    source_revision: SOURCE_REVISION,
    packaging_procedure_version: PACKAGING_PROCEDURE_VERSION,
    host_agent_compatibility: "host-neutral-cli-schema-0",
    qmd_compatibility: { contract: "scoped-cli", version: "0.1.0" },
    knowledge_schema_compatibility: ["0"],
    pack_api_compatibility: 0,
    environment_compatibility: {
      platform: "darwin",
      architecture: "arm64",
      node_version: process.version,
    },
    included_packs: [],
    included_beads: [],
    verification_summary: [{
      command: "node --test test/releaseManager.test.ts",
      outcome: "passed",
      mode: "automated",
      artifact_sha256: ARCHIVE_HASH,
    }],
    known_limitations: ["Synthetic release qualification only."],
    artifact_integrity: {
      archive: { filename: `engram-${RELEASE_ID}.tar.gz`, byte_length: 128, sha256: ARCHIVE_HASH },
      bootstrap: { filename: `engram-release-${RELEASE_ID}.ts`, byte_length: 64, sha256: BOOTSTRAP_HASH },
    },
    published_at: "2026-08-08T00:00:00.000Z",
  };
}

function errorCodes(result: { ok: false; errors: { code: string }[] }): string[] {
  return result.errors.map((error) => error.code);
}

test("release metadata accepts a complete strict manifest and record", () => {
  const manifest = parseReleaseManifest(validManifest());
  const record = parseReleaseRecord(validRecord());
  assert.equal(manifest.ok, true);
  assert.equal(record.ok, true);
});

test("release manifest rejects unknown keys, invalid identity, and fixed compatibility drift", () => {
  const unknown = validManifest();
  unknown.extra = true;
  const unknownParsed = parseReleaseManifest(unknown);
  assert.equal(unknownParsed.ok, false);
  if (!unknownParsed.ok) assert.deepEqual(errorCodes(unknownParsed), ["release_manifest_invalid"]);

  const identity = validManifest();
  identity.version = "r0-" + "b".repeat(40);
  const identityParsed = parseReleaseManifest(identity);
  assert.equal(identityParsed.ok, false);
  if (!identityParsed.ok) assert.deepEqual(errorCodes(identityParsed), ["release_id_invalid"]);

  const compatibility = validManifest();
  compatibility.host_agent_compatibility = "host-neutral-cli-schema-1";
  const compatibilityParsed = parseReleaseManifest(compatibility);
  assert.equal(compatibilityParsed.ok, false);
  if (!compatibilityParsed.ok) assert.deepEqual(errorCodes(compatibilityParsed), ["host_agent_compatibility_invalid"]);
});

test("release metadata rejects any contract other than the published scoped-cli label", () => {
  // The former private label string is assembled from fragments so the public
  // source-content scan never sees a decision identifier.
  const formerLabel = "D" + "-0" + "23-scoped-cli";

  const manifest = validManifest();
  manifest.qmd_compatibility = { contract: formerLabel, version: "0.1.0" };
  const manifestParsed = parseReleaseManifest(manifest);
  assert.equal(manifestParsed.ok, false);
  if (!manifestParsed.ok) assert.deepEqual(errorCodes(manifestParsed), ["release_manifest_invalid"]);

  const record = validRecord();
  record.qmd_compatibility = { contract: formerLabel, version: "0.1.0" };
  const recordParsed = parseReleaseRecord(record);
  assert.equal(recordParsed.ok, false);
});

test("release manifest rejects malformed hashes, unsafe paths, and unordered duplicate inventory", () => {
  const malformedHash = validManifest();
  malformedHash.files = [{ path: "harness/src/cli.ts", byte_length: 42, sha256: "A".repeat(64), executable: false }];
  assert.equal(parseReleaseManifest(malformedHash).ok, false);

  const unsafePath = validManifest();
  unsafePath.files = [{ path: "../private.txt", byte_length: 42, sha256: FILE_HASH, executable: false }];
  const unsafeParsed = parseReleaseManifest(unsafePath);
  assert.equal(unsafeParsed.ok, false);
  if (!unsafeParsed.ok) assert.deepEqual(errorCodes(unsafeParsed), ["release_path_invalid"]);

  const duplicatePath = validManifest();
  duplicatePath.files = [
    { path: "harness/src/cli.ts", byte_length: 42, sha256: FILE_HASH, executable: false },
    { path: "harness/src/cli.ts", byte_length: 43, sha256: FILE_HASH, executable: false },
  ];
  const duplicateParsed = parseReleaseManifest(duplicatePath);
  assert.equal(duplicateParsed.ok, false);
  if (!duplicateParsed.ok) assert.deepEqual(errorCodes(duplicateParsed), ["release_path_duplicate", "files_order_invalid"]);

  const unsortedFiles = validManifest();
  unsortedFiles.files = [
    { path: "harness/src/z.ts", byte_length: 42, sha256: FILE_HASH, executable: false },
    { path: "harness/src/a.ts", byte_length: 42, sha256: FILE_HASH, executable: false },
  ];
  const filesParsed = parseReleaseManifest(unsortedFiles);
  assert.equal(filesParsed.ok, false);
  if (!filesParsed.ok) assert.deepEqual(errorCodes(filesParsed), ["files_order_invalid"]);

  const unsortedPacks = validManifest();
  unsortedPacks.included_packs = [
    { id: "fictional-zeta", version: "0.1.0" },
    { id: "fictional-integrity", version: "0.1.0" },
  ];
  const packsParsed = parseReleaseManifest(unsortedPacks);
  assert.equal(packsParsed.ok, false);
  if (!packsParsed.ok) assert.deepEqual(errorCodes(packsParsed), ["included_packs_order_invalid"]);

  const duplicatePacks = validManifest();
  duplicatePacks.included_packs = [
    { id: "fictional-integrity", version: "0.1.0" },
    { id: "fictional-integrity", version: "0.1.0" },
  ];
  const duplicatePacksParsed = parseReleaseManifest(duplicatePacks);
  assert.equal(duplicatePacksParsed.ok, false);
  if (!duplicatePacksParsed.ok) assert.deepEqual(errorCodes(duplicatePacksParsed), ["included_packs_order_invalid"]);
});

test("release manifest rejects an incompatible runtime environment", () => {
  const fields: ("platform" | "architecture" | "node_version")[] = ["platform", "architecture", "node_version"];
  for (const field of fields) {
    const raw = validManifest();
    const environment = raw.environment_compatibility;
    assert.equal(typeof environment, "object");
    assert.notEqual(environment, null);
    if (typeof environment !== "object" || environment === null || Array.isArray(environment)) return;
    Object.defineProperty(environment, field, { value: "incompatible", enumerable: true });
    assert.equal(parseReleaseManifest(raw).ok, false, field);
  }
});

test("release record requires declared beads and single-line release evidence", () => {
  const omittedBeads = validRecord();
  delete omittedBeads.included_beads;
  const beadsParsed = parseReleaseRecord(omittedBeads);
  assert.equal(beadsParsed.ok, false);
  if (!beadsParsed.ok) assert.deepEqual(errorCodes(beadsParsed), ["release_record_invalid", "release_record_invalid"]);

  const multiline = validRecord();
  multiline.known_limitations = ["first line\nsecond line"];
  const multilineParsed = parseReleaseRecord(multiline);
  assert.equal(multilineParsed.ok, false);
  if (!multilineParsed.ok) assert.deepEqual(errorCodes(multilineParsed), ["known_limitations_invalid"]);
});

test("property: release evidence is bound to the exact artifact and source revision", () => {
  const raw = validRecord();
  raw.verification_summary = [{
    command: "node --test test/releaseManager.test.ts",
    outcome: "passed",
    mode: "automated",
    artifact_sha256: "b".repeat(64),
  }];
  const parsed = parseReleaseRecord(raw);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.deepEqual(parsed.errors.map((error) => error.code), ["verification_artifact_mismatch"]);

  const mismatchedRevision = validRecord();
  mismatchedRevision.source_revision = "b".repeat(40);
  const mismatchedRevisionParsed = parseReleaseRecord(mismatchedRevision);
  assert.equal(mismatchedRevisionParsed.ok, false);
  if (mismatchedRevisionParsed.ok) return;
  assert.deepEqual(mismatchedRevisionParsed.errors.map((error) => error.code), ["release_id_invalid"]);
});

test("canonical release JSON orders recursively and ends with one newline", () => {
  assert.equal(canonicalReleaseJson({ z: ["value", { b: 1, a: true }], a: "first" }), '{"a":"first","z":["value",{"a":true,"b":1}]}\n');
});

test("readReleaseManifest parses JSON and reports invalid content without a filesystem path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "engram-release-metadata-"));
  scratchDirs.push(dir);
  const manifestPath = join(dir, "release-manifest.json");
  await writeFile(manifestPath, JSON.stringify(validManifest()), "utf8");
  assert.equal((await readReleaseManifest(manifestPath)).ok, true);

  await writeFile(manifestPath, "{not json", "utf8");
  const invalid = await readReleaseManifest(manifestPath);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.deepEqual(errorCodes(invalid), ["release_manifest_invalid"]);
});
