import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { getActiveClaims, getEvidenceLog, parseRecord, serializeRecord, withMutatedContent } from "../src/markdownRecord.ts";
import { SPACE_A_RECORDS_DIR } from "./testSupport.ts";

test("parses the payments-gateway fixture into structured claims and evidence", async () => {
  const text = await readFile(join(SPACE_A_RECORDS_DIR, "payments-gateway.md"), "utf8");
  const result = parseRecord(text);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.frontmatter.id, "payments-gateway");
  assert.equal(result.value.frontmatter.title, "Payments Gateway (legacy)");
  assert.equal(result.value.frontmatter.updated, "2026-07-30");
  const claims = getActiveClaims(result.value);
  const evidence = getEvidenceLog(result.value);
  assert.equal(claims.length, 4);
  assert.equal(evidence.length, 4);
  assert.match(claims[0] ?? "", /Retries are not idempotent/);
});

test("serializeRecord(parseRecord(x)) round-trips a fixture byte-for-byte", async () => {
  const text = await readFile(join(SPACE_A_RECORDS_DIR, "checkout-api.md"), "utf8");
  const result = parseRecord(text);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const roundTripped = serializeRecord(result.value);
  assert.equal(roundTripped, text);
});

test("rejects a record missing the frontmatter delimiter", () => {
  const result = parseRecord("id: foo\ntitle: Foo\n");
  assert.equal(result.ok, false);
});

test("rejects a record with an unclosed frontmatter block", () => {
  const result = parseRecord("---\nid: foo\ntitle: Foo\nupdated: 2026-01-01\n\n## Active claims\n");
  assert.equal(result.ok, false);
});

test("rejects a record missing the Evidence log section", () => {
  const text = ["---", "id: foo", "title: Foo", "updated: 2026-01-01", "---", "", "## Active claims", "", "- a claim", ""].join(
    "\n",
  );
  const result = parseRecord(text);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes("Evidence log")));
});

test("rejects a record with unknown frontmatter fields", () => {
  const text = [
    "---",
    "id: foo",
    "title: Foo",
    "updated: 2026-01-01",
    "owner: someone",
    "---",
    "",
    "## Active claims",
    "",
    "## Evidence log",
    "",
  ].join("\n");
  const result = parseRecord(text);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes("owner")));
});

test("rejects sections out of order", () => {
  const text = [
    "---",
    "id: foo",
    "title: Foo",
    "updated: 2026-01-01",
    "---",
    "",
    "## Evidence log",
    "",
    "- an entry",
    "",
    "## Active claims",
    "",
    "- a claim",
    "",
  ].join("\n");
  const result = parseRecord(text);
  assert.equal(result.ok, false);
});

test("preserves an unknown '## Notes' section between the two known sections through parse and serialize", () => {
  const text = [
    "---",
    "id: foo",
    "title: Foo",
    "updated: 2026-01-01",
    "---",
    "",
    "## Active claims",
    "",
    "- a claim",
    "",
    "## Notes",
    "",
    "Free-form prose that the record parser does not model at all.",
    "",
    "## Evidence log",
    "",
    "- an entry",
    "",
  ].join("\n");

  const result = parseRecord(text);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const otherSections = result.value.sections.filter((s) => s.kind === "other");
  assert.equal(otherSections.length, 1);
  assert.equal(otherSections[0]?.heading, "## Notes");
  assert.ok(otherSections[0]?.lines.some((l) => l.includes("Free-form prose")));

  // Round-trips byte-for-byte even though Notes is never touched.
  assert.equal(serializeRecord(result.value), text);
});

test("preserves an unknown section through withMutatedContent (a write that only touches claims/evidence)", () => {
  const text = [
    "---",
    "id: foo",
    "title: Foo",
    "updated: 2026-01-01",
    "---",
    "",
    "## Active claims",
    "",
    "- a claim",
    "",
    "## Notes",
    "",
    "Important context a candidate never asked to change.",
    "",
    "## Evidence log",
    "",
    "- an entry",
    "",
  ].join("\n");

  const result = parseRecord(text);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const mutated = withMutatedContent(result.value, {
    frontmatter: result.value.frontmatter,
    activeClaims: [...getActiveClaims(result.value), "a new claim"],
    evidenceLog: getEvidenceLog(result.value),
  });

  const serialized = serializeRecord(mutated);
  assert.match(serialized, /Important context a candidate never asked to change\./);
  assert.match(serialized, /- a new claim/);
});

// Fix 1 (adversarial review, cycle 3): content before the first `##`
// heading was parsed and then silently discarded on write — a HIGH
// finding because classify.ts still classified the resulting write as
// additive (candidate directives never mentioned the preamble at all).

test("preserves preamble prose (content before the first '##' heading) through parse and serialize", () => {
  const text = [
    "---",
    "id: foo",
    "title: Foo",
    "updated: 2026-01-01",
    "---",
    "",
    "This record carries introductory prose that predates the claims/evidence model.",
    "It spans more than one line.",
    "",
    "## Active claims",
    "",
    "- a claim",
    "",
    "## Evidence log",
    "",
    "- an entry",
    "",
  ].join("\n");

  const result = parseRecord(text);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.ok(result.value.preambleLines.some((l) => l.includes("introductory prose")));
  assert.ok(result.value.preambleLines.some((l) => l.includes("spans more than one line")));

  // Round-trips byte-for-byte.
  assert.equal(serializeRecord(result.value), text);
});

test("a record with no real preamble (just the mandatory blank separator line) still round-trips byte-for-byte", async () => {
  const text = await readFile(join(SPACE_A_RECORDS_DIR, "payments-gateway.md"), "utf8");
  const result = parseRecord(text);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.preambleLines, [""]);
  assert.equal(serializeRecord(result.value), text);
});

test("withMutatedContent preserves the preamble even though a write only touches claims/evidence", () => {
  const text = [
    "---",
    "id: foo",
    "title: Foo",
    "updated: 2026-01-01",
    "---",
    "",
    "Preamble content a candidate never asked to change.",
    "",
    "## Active claims",
    "",
    "- a claim",
    "",
    "## Evidence log",
    "",
    "- an entry",
    "",
  ].join("\n");

  const result = parseRecord(text);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const mutated = withMutatedContent(result.value, {
    frontmatter: result.value.frontmatter,
    activeClaims: [...getActiveClaims(result.value), "a new claim"],
    evidenceLog: getEvidenceLog(result.value),
  });

  const serialized = serializeRecord(mutated);
  assert.match(serialized, /Preamble content a candidate never asked to change\./);
  assert.match(serialized, /- a new claim/);
});

test("rejects a record with more than one '## Active claims' section", () => {
  const text = [
    "---",
    "id: foo",
    "title: Foo",
    "updated: 2026-01-01",
    "---",
    "",
    "## Active claims",
    "",
    "- a claim",
    "",
    "## Active claims",
    "",
    "- a forged duplicate",
    "",
    "## Evidence log",
    "",
    "- an entry",
    "",
  ].join("\n");

  const result = parseRecord(text);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes("more than one")));
});
