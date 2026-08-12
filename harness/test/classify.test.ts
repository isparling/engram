import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCandidate } from "../src/candidate.ts";
import { mutationPreservesAllContent, planMutation } from "../src/classify.ts";
import { getActiveClaims, getEvidenceLog, parseRecord, withMutatedContent } from "../src/markdownRecord.ts";

const SAMPLE_RECORD = [
  "---",
  "id: sample",
  "title: Sample",
  "updated: 2026-01-01",
  "---",
  "",
  "## Active claims",
  "",
  "- First claim. [source: a]",
  "- Second claim. [source: a]",
  "",
  "## Evidence log",
  "",
  "- 2026-01-01 — First entry. [source: a]",
  "",
].join("\n");

function parseSample() {
  const result = parseRecord(SAMPLE_RECORD);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("fixture should parse");
  return result.value;
}

test("a candidate that only adds claims/evidence classifies as additive", () => {
  const record = parseSample();
  const candidateResult = validateCandidate({
    target_id: "sample",
    source: "new-source",
    add_claims: ["A new claim."],
    add_evidence: [{ date: "2026-02-01", text: "A new entry." }],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(SAMPLE_RECORD, record, candidateResult.value, "2026-02-01");
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.value.classification, "additive");
  const claims = getActiveClaims(plan.value.after);
  const evidence = getEvidenceLog(plan.value.after);
  assert.equal(claims.length, 3);
  assert.equal(evidence.length, 2);
  assert.equal(claims[2], "A new claim. [source: new-source]");
  assert.equal(evidence[1], "2026-02-01 — A new entry. [source: new-source]");
  // Mechanical updated-date stamping does not affect classification.
  assert.equal(plan.value.after.frontmatter.updated, "2026-02-01");
});

test("removing an existing claim classifies as non-additive", () => {
  const record = parseSample();
  const candidateResult = validateCandidate({
    target_id: "sample",
    source: "new-source",
    remove_claims: ["First claim. [source: a]"],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(SAMPLE_RECORD, record, candidateResult.value, "2026-02-01");
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.value.classification, "non-additive");
  const claims = getActiveClaims(plan.value.after);
  assert.equal(claims.length, 1);
  assert.deepEqual(claims, ["Second claim. [source: a]"]);
});

test("rewriting an existing evidence entry classifies as non-additive", () => {
  const record = parseSample();
  const candidateResult = validateCandidate({
    target_id: "sample",
    source: "new-source",
    rewrite_evidence: [{ from: "2026-01-01 — First entry. [source: a]", to: "2026-01-01 — Corrected entry. [source: a]" }],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(SAMPLE_RECORD, record, candidateResult.value, "2026-02-01");
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.value.classification, "non-additive");
  assert.deepEqual(getEvidenceLog(plan.value.after), ["2026-01-01 — Corrected entry. [source: a]"]);
});

test("a frontmatter title change classifies as non-additive even with no claim changes", () => {
  const record = parseSample();
  const candidateResult = validateCandidate({
    target_id: "sample",
    source: "new-source",
    frontmatter: { title: "Renamed Sample" },
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(SAMPLE_RECORD, record, candidateResult.value, "2026-02-01");
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.value.classification, "non-additive");
  assert.equal(plan.value.after.frontmatter.title, "Renamed Sample");
});

test("removing a claim that does not exist fails validation with no plan produced", () => {
  const record = parseSample();
  const candidateResult = validateCandidate({
    target_id: "sample",
    source: "new-source",
    remove_claims: ["A claim that was never there."],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(SAMPLE_RECORD, record, candidateResult.value, "2026-02-01");
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.ok(plan.errors.some((e) => e.includes("not found")));
});

test("the diff shows the mechanical updated-date change even for an additive candidate", () => {
  const record = parseSample();
  const candidateResult = validateCandidate({
    target_id: "sample",
    source: "new-source",
    add_claims: ["Another claim."],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(SAMPLE_RECORD, record, candidateResult.value, "2026-03-15");
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.match(plan.value.diff, /-updated: 2026-01-01/);
  assert.match(plan.value.diff, /\+updated: 2026-03-15/);
});

// Item 4 of the adversarial review: directives must resolve against the
// ORIGINAL record state, not a sequential pipeline. The exact example
// from the review: rewrite_claims [{from:"B",to:"A"}] plus
// remove_claims:["A"] on [A,B] must yield ["A"] (B rewritten to "A"),
// never [] (which is what sequential map-then-filter produces, because
// after the rewrite both entries read "A" and the remove step then drops
// both).

const AB_RECORD = [
  "---",
  "id: ab",
  "title: AB",
  "updated: 2026-01-01",
  "---",
  "",
  "## Active claims",
  "",
  "- A",
  "- B",
  "",
  "## Evidence log",
  "",
  "",
].join("\n");

function parseAB() {
  const result = parseRecord(AB_RECORD);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("fixture should parse");
  return result.value;
}

test("a rewrite whose result matches a separately removed original entry resolves correctly against original state, not sequential application", () => {
  const record = parseAB();
  const candidateResult = validateCandidate({
    target_id: "ab",
    source: "x",
    remove_claims: ["A"],
    rewrite_claims: [{ from: "B", to: "A" }],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(AB_RECORD, record, candidateResult.value, "2026-02-01");
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(getActiveClaims(plan.value.after), ["A"]);
});

test("rejects a candidate where the same original claim is targeted by both remove and rewrite", () => {
  const record = parseAB();
  const candidateResult = validateCandidate({
    target_id: "ab",
    source: "x",
    remove_claims: ["A"],
    rewrite_claims: [{ from: "A", to: "X" }],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(AB_RECORD, record, candidateResult.value, "2026-02-01");
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.ok(plan.errors.some((e) => e.includes("both a remove and a rewrite")));
});

test("rejects a candidate with two conflicting rewrite directives for the same original claim", () => {
  const record = parseAB();
  const candidateResult = validateCandidate({
    target_id: "ab",
    source: "x",
    rewrite_claims: [
      { from: "A", to: "X" },
      { from: "A", to: "Y" },
    ],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(AB_RECORD, record, candidateResult.value, "2026-02-01");
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.ok(plan.errors.some((e) => e.includes("conflicting rewrite directives")));
});

test("independent (non-overlapping) remove and rewrite directives both apply correctly", () => {
  const record = parseAB();
  // Removing "A" and rewriting "B" to something else are independent —
  // this must NOT be rejected as a conflict.
  const candidateResult = validateCandidate({
    target_id: "ab",
    source: "x",
    remove_claims: ["A"],
    rewrite_claims: [{ from: "B", to: "B renamed" }],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(AB_RECORD, record, candidateResult.value, "2026-02-01");
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(getActiveClaims(plan.value.after), ["B renamed"]);
});

// Fix 1 (adversarial review, cycle 3), HIGH: content before the first
// heading (preamble) was silently dropped on write, and classification
// derived only from candidate directives — so a purely additive candidate
// against a record with preamble committed as "additive" while quietly
// destroying the preamble. Two independent things are tested below:
// (a) an end-to-end scenario proving today's implementation classifies
// correctly and preserves the preamble together, and (b) the derived
// safety-net function itself, directly, against synthetic content loss
// that no longer occurs through today's implementation but must still be
// caught if it ever recurred.

const RECORD_WITH_PREAMBLE = [
  "---",
  "id: sample",
  "title: Sample",
  "updated: 2026-01-01",
  "---",
  "",
  "This preamble predates the claims/evidence model and is not a claim.",
  "",
  "## Active claims",
  "",
  "- First claim. [source: a]",
  "",
  "## Evidence log",
  "",
  "- 2026-01-01 — First entry. [source: a]",
  "",
].join("\n");

test("a purely additive candidate against a record with preamble classifies additive AND preserves the preamble in the resulting text", () => {
  const result = parseRecord(RECORD_WITH_PREAMBLE);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const candidateResult = validateCandidate({
    target_id: "sample",
    source: "x",
    add_claims: ["A new claim."],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(RECORD_WITH_PREAMBLE, result.value, candidateResult.value, "2026-02-01");
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.value.classification, "additive");
  assert.match(plan.value.afterText, /This preamble predates the claims\/evidence model/);
});

test("mutationPreservesAllContent: identical before/after (nothing changed) preserves content", () => {
  const result = parseRecord(RECORD_WITH_PREAMBLE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(mutationPreservesAllContent(result.value, result.value), true);
});

test("mutationPreservesAllContent: pure addition (no removal) preserves content", () => {
  const result = parseRecord(RECORD_WITH_PREAMBLE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const record = result.value;
  const after = withMutatedContent(record, {
    frontmatter: record.frontmatter,
    activeClaims: [...getActiveClaims(record), "A brand new claim."],
    evidenceLog: getEvidenceLog(record),
  });
  assert.equal(mutationPreservesAllContent(record, after), true);
});

test("mutationPreservesAllContent detects a dropped preamble even when claims/evidence are untouched (the exact bug this fix closes)", () => {
  const result = parseRecord(RECORD_WITH_PREAMBLE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const record = result.value;
  // Simulate what the OLD buggy parser/serializer produced: an "after"
  // identical to "before" except the preamble is gone.
  const afterWithDroppedPreamble = { ...record, preambleLines: [] };
  assert.equal(mutationPreservesAllContent(record, afterWithDroppedPreamble), false);
});

test("mutationPreservesAllContent detects a dropped 'other' section", () => {
  const text = [
    "---",
    "id: sample",
    "title: Sample",
    "updated: 2026-01-01",
    "---",
    "",
    "## Active claims",
    "",
    "- a claim",
    "",
    "## Notes",
    "",
    "Content a future bug might drop.",
    "",
    "## Evidence log",
    "",
    "- an entry",
    "",
  ].join("\n");
  const result = parseRecord(text);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const record = result.value;
  const afterWithDroppedNotes = { ...record, sections: record.sections.filter((s) => s.kind !== "other") };
  assert.equal(mutationPreservesAllContent(record, afterWithDroppedNotes), false);
});

test("mutationPreservesAllContent detects a dropped claim even when the candidate declared no destructive directive", () => {
  const result = parseRecord(RECORD_WITH_PREAMBLE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const record = result.value;
  // Simulate a hypothetical future bug in resolveTextList/withMutatedContent
  // that drops an original claim without the candidate ever asking to
  // remove it.
  const afterWithDroppedClaim = withMutatedContent(record, {
    frontmatter: record.frontmatter,
    activeClaims: [],
    evidenceLog: getEvidenceLog(record),
  });
  assert.equal(mutationPreservesAllContent(record, afterWithDroppedClaim), false);
});

test("mutationPreservesAllContent detects a title change", () => {
  const result = parseRecord(RECORD_WITH_PREAMBLE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const record = result.value;
  const afterWithRenamedTitle = withMutatedContent(record, {
    frontmatter: { ...record.frontmatter, title: "Renamed" },
    activeClaims: getActiveClaims(record),
    evidenceLog: getEvidenceLog(record),
  });
  assert.equal(mutationPreservesAllContent(record, afterWithRenamedTitle), false);
});

// The tests above prove the DETECTOR (mutationPreservesAllContent) works
// in isolation. They do NOT prove planMutation's classification actually
// COMBINES it with the directive-declared signal: under today's correct
// resolveTextList/withMutatedContent, a directive-declared-additive
// candidate never produces content loss, so the detector always returns
// true in every reachable case and the `|| !contentPreserved` clause is
// unreachable via real input — meaning a test that only exercises real
// candidates cannot tell the wiring apart from its absence. Confirmed
// directly: temporarily removing the `|| !contentPreserved` clause during
// this fix's revert-verification caused zero test failures elsewhere.
//
// planMutation's optional contentCheck parameter exists for exactly this
// reason — the same injection pattern already used for qmdRunner's
// spawnFn and submit.ts's writeRecord, for the same reason: to make an
// otherwise-unreachable code path directly, deterministically testable.

test("planMutation's classification wiring: an injected always-false content check forces non-additive even for a purely additive candidate", () => {
  const record = parseSample();
  const candidateResult = validateCandidate({
    target_id: "sample",
    source: "x",
    add_claims: ["A new claim."],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(SAMPLE_RECORD, record, candidateResult.value, "2026-02-01", () => false);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.value.classification, "non-additive");
});

test("planMutation's classification wiring: an injected always-true content check does not downgrade a directive-declared non-additive candidate", () => {
  const record = parseSample();
  const candidateResult = validateCandidate({
    target_id: "sample",
    source: "x",
    remove_claims: ["First claim. [source: a]"],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(SAMPLE_RECORD, record, candidateResult.value, "2026-02-01", () => true);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.value.classification, "non-additive");
});

test("planMutation defaults contentCheck to the real mutationPreservesAllContent when not supplied", () => {
  const record = parseSample();
  const candidateResult = validateCandidate({
    target_id: "sample",
    source: "x",
    add_claims: ["A new claim."],
  });
  assert.equal(candidateResult.ok, true);
  if (!candidateResult.ok) return;

  const plan = planMutation(SAMPLE_RECORD, record, candidateResult.value, "2026-02-01");
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.value.classification, "additive");
});
