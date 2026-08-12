import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadExtractionPack, resolveKnowledgePack } from "../src/packLoader.ts";
import type { TurnContext, PackHelpers } from "../src/knowledgeTypes.ts";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(FIXTURE_DIR, "packLoader.fixture.ts");
const INVALID_FIXTURE_PATH = join(FIXTURE_DIR, "packLoader.invalid.fixture.ts");
const MISSING_FIXTURE_PATH = join(FIXTURE_DIR, "packLoader.no-such-fixture.ts");
const EMPTY_FIXTURE_PATH = join(FIXTURE_DIR, "packLoader.empty.fixture.ts");

/** Error codes of a failed result; fails the assertion if the result is ok. */
function errorCodes(result: { ok: true } | { ok: false; errors: Array<{ code: string }> }): string[] {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected a failed result");
  return result.errors.map((error) => error.code);
}

// ---------------------------------------------------------------------------
// resolveKnowledgePack — from requirement
// ---------------------------------------------------------------------------

test("resolveKnowledgePack refuses undefined from as pack_from_required", async () => {
  const result = await resolveKnowledgePack("fictional-integrity", "0.1.0", undefined);
  assert.deepEqual(errorCodes(result), ["pack_from_required"]);
});

test("resolveKnowledgePack refuses an empty from as pack_from_required", async () => {
  const result = await resolveKnowledgePack("fictional-integrity", "0.1.0", "");
  assert.deepEqual(errorCodes(result), ["pack_from_required"]);
});

test("resolveKnowledgePack refuses a whitespace-only from as pack_from_required", async () => {
  const result = await resolveKnowledgePack("fictional-integrity", "0.1.0", "   ");
  assert.deepEqual(errorCodes(result), ["pack_from_required"]);
});

// ---------------------------------------------------------------------------
// resolveKnowledgePack — load, export, and identity categories
// ---------------------------------------------------------------------------

test("resolveKnowledgePack reports pack_load_failed for a missing module and never leaks the path", async () => {
  const result = await resolveKnowledgePack("fictional-integrity", "0.1.0", MISSING_FIXTURE_PATH);
  assert.deepEqual(errorCodes(result), ["pack_load_failed"]);
  if (result.ok) return;
  for (const error of result.errors) {
    assert.ok(!error.message.includes(MISSING_FIXTURE_PATH), "error message must not contain the module path");
  }
});


test("property: a pack missing required knowledge or presentation members is refused before use", async () => {
  const result = await resolveKnowledgePack("invalid-demo", "0.1.0", INVALID_FIXTURE_PATH);
  assert.deepEqual(errorCodes(result), ["pack_export_invalid"]);
});

test("resolveKnowledgePack reports pack_export_invalid when the loaded module has no candidate export", async () => {
  const result = await resolveKnowledgePack("no-such-pack", "0.1.0", EMPTY_FIXTURE_PATH);
  assert.deepEqual(errorCodes(result), ["pack_export_invalid"]);
});

test("resolveKnowledgePack refuses a version mismatch as pack_identity_mismatch", async () => {
  const result = await resolveKnowledgePack("fictional-integrity", "0.1.0", FIXTURE_PATH);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.errors.map((error) => error.code), ["pack_identity_mismatch"]);
});

test("resolveKnowledgePack refuses an id mismatch as pack_identity_mismatch", async () => {
  const result = await resolveKnowledgePack("some-other-pack", "9.9.9", FIXTURE_PATH);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.errors.map((error) => error.code), ["pack_identity_mismatch"]);
});

test("resolveKnowledgePack resolves a matching external pack by named export", async () => {
  const result = await resolveKnowledgePack("external-demo", "0.1.0", FIXTURE_PATH);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.id, "external-demo");
  assert.equal(result.value.version, "0.1.0");
  assert.equal(typeof result.value.validateEnvelope, "function");
});

test("property: a relative from specifier resolves from its declaring binding file", async () => {
  const result = await resolveKnowledgePack(
    "external-demo",
    "0.1.0",
    "./packLoader.fixture.ts",
    join(FIXTURE_DIR, "binding.json"),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.id, "external-demo");
});

// ---------------------------------------------------------------------------
// loadExtractionPack — extractor contract
// ---------------------------------------------------------------------------

test("loadExtractionPack refuses undefined from as pack_from_required", async () => {
  const result = await loadExtractionPack("fictional-extractor", "0.1.0", undefined);
  assert.deepEqual(errorCodes(result), ["pack_from_required"]);
});

test("loadExtractionPack refuses an empty from as pack_from_required", async () => {
  const result = await loadExtractionPack("fictional-extractor", "0.1.0", "");
  assert.deepEqual(errorCodes(result), ["pack_from_required"]);
});

test("loadExtractionPack reports pack_load_failed for a missing module", async () => {
  const result = await loadExtractionPack("fictional-extractor", "0.1.0", MISSING_FIXTURE_PATH);
  assert.deepEqual(errorCodes(result), ["pack_load_failed"]);
});

test("loadExtractionPack reports pack_export_invalid for a module without a KnowledgeExtractor", async () => {
  const result = await loadExtractionPack("fictional-extractor", "0.1.0", INVALID_FIXTURE_PATH);
  assert.deepEqual(errorCodes(result), ["pack_export_invalid"]);
});

test("loadExtractionPack loads a KnowledgeExtractor by named export", async () => {
  const result = await loadExtractionPack("fictional-extractor", "0.1.0", FIXTURE_PATH);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.id, "fictional-extractor");
  assert.equal(result.value.version, "0.1.0");
  assert.equal(typeof result.value.extractCandidates, "function");
});

test("loadExtractionPack refuses an extractor whose version differs from the declared identity", async () => {
  const result = await loadExtractionPack("fictional-extractor", "0.2.0", FIXTURE_PATH);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.errors.map((error) => error.code), ["pack_identity_mismatch"]);
});

test("loadExtractionPack refuses an extractor whose id differs from the declared identity", async () => {
  const result = await loadExtractionPack("miskeyedExtractor", "0.1.0", FIXTURE_PATH);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.errors.map((error) => error.code), ["pack_identity_mismatch"]);
});

test("loaded extractor returns candidates for a minimal turn", async () => {
  const result = await loadExtractionPack("fictional-extractor", "0.1.0", FIXTURE_PATH);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const extractor = result.value;

  const turn: TurnContext = {
    session: { id: "test-session", host: "node-test" },
    turnIndex: 1,
    timestamp: new Date().toISOString(),
    narrative: "User asked about the project structure. Agent explained the layout.",
    toolCalls: [],
  };

  const helpers: PackHelpers = {};
  const candidates = await extractor.extractCandidates(turn, helpers);
  assert.ok(Array.isArray(candidates));
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.ok(candidate !== undefined);
  assert.equal(candidate.kind, "claim");
  assert.equal(candidate.disposition, "new");
});