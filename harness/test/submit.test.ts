import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { AtomicWriteDirectorySyncError } from "../src/atomicWrite.ts";
import { runQmd } from "../src/qmdRunner.ts";
import { submitCandidate } from "../src/submit.ts";
import {
  chmodDirAndContents,
  createEphemeralSpace,
  createUninitializedEphemeralSpace,
  destroyEphemeralSpace,
  SPACE_A_RECORDS_DIR,
  type EphemeralSpace,
} from "./testSupport.ts";

const spacesToClean: EphemeralSpace[] = [];

async function space(name: string): Promise<EphemeralSpace> {
  const s = await createEphemeralSpace(SPACE_A_RECORDS_DIR, name);
  spacesToClean.push(s);
  return s;
}

after(async () => {
  for (const s of spacesToClean) {
    await destroyEphemeralSpace(s);
  }
});

test("happy path: an additive candidate commits without --approve and reports fresh", async () => {
  const s = await space("submit-happy-additive");

  const result = await submitCandidate({
    binding: s.binding,
    candidateInput: {
      target_id: "payments-gateway",
      source: "incident-4471",
      add_claims: ["A canary rollout stage was added to the deploy pipeline."],
      add_evidence: [{ date: "2026-08-02", text: "Canary stage landed in the deploy pipeline." }],
    },
    approve: false,
    submittedAt: "2026-08-02",
  });

  assert.equal(result.schema_version, 0);
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.equal(result.classification, "additive");
  assert.equal(result.refresh.attempted, true);
  assert.equal(result.refresh.count, 1);
  assert.equal(result.refresh.state, "fresh");

  const written = await readFile(result.written_path, "utf8");
  assert.match(written, /A canary rollout stage was added to the deploy pipeline\. \[source: incident-4471\]/);
  assert.match(written, /updated: 2026-08-02/);

  // Verification probe (not a second CLI operation): confirm the refreshed
  // index actually contains the new fixture content, through the same
  // single qmd spawn point used everywhere else.
  const search = await runQmd(
    ["search", "canary rollout stage", "--json", "-c", s.binding.qmdCollectionName],
    s.binding,
  );
  assert.equal(search.code, 0);
  const hits = JSON.parse(search.stdout) as Array<{ file: string }>;
  assert.ok(hits.some((h) => h.file.includes("payments-gateway.md")));
});

test("property: submit refuses a target record symlink before reading its outside target", async () => {
  const s = await space("submit-record-symlink");
  const recordPath = join(s.binding.recordsRoot, "payments-gateway.md");
  const outsidePath = join(s.root, "outside-record.md");
  await writeFile(outsidePath, await readFile(recordPath, "utf8"), "utf8");
  await rm(recordPath);
  await symlink(outsidePath, recordPath);

  const result = await submitCandidate({
    binding: s.binding,
    candidateInput: {
      target_id: "payments-gateway",
      source: "synthetic-symlink",
      add_claims: ["This must not read an outside record."],
      add_evidence: [],
    },
    approve: false,
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "invalid");
  assert.match(result.errors.join(" "), /symbolic link|outside the bound records root/);
});

// Required test #1: a rejected (unapproved) non-additive candidate performs
// no refresh and leaves the record byte-identical.
test("an unapproved non-additive candidate performs no refresh and leaves the record byte-identical", async () => {
  const s = await space("submit-unapproved-non-additive");
  const recordPath = join(s.binding.recordsRoot, "checkout-api.md");
  const before = await readFile(recordPath);

  const result = await submitCandidate({
    binding: s.binding,
    candidateInput: {
      target_id: "checkout-api",
      source: "flag-cleanup",
      remove_claims: [
        "Feature flag checkout.newPricingEngine is at 100% in the config map but the old pricing engine code path has not been deleted, so both are live dependencies. [source: code-audit-118]",
      ],
    },
    approve: false,
    submittedAt: "2026-08-02",
  });

  assert.equal(result.schema_version, 0);
  assert.equal(result.status, "approval_required");
  if (result.status !== "approval_required") return;
  assert.equal(result.classification, "non-additive");
  // Diff line = removal marker "-" + the original bullet's own "- " prefix.
  assert.match(result.diff, /^-- Feature flag checkout\.newPricingEngine/m);
  assert.equal(result.refresh.attempted, false);
  assert.equal(result.refresh.count, 0);
  assert.match(result.plan_hash, /^[0-9a-f]{64}$/);

  const after = await readFile(recordPath);
  assert.ok(before.equals(after), "record bytes must be unchanged when approval is required and not given");
});

// Item 5 of the adversarial review: approval must be bound to the exact
// record the caller saw the diff against.

test("the same non-additive candidate commits when approved with the matching plan_hash", async () => {
  const s = await space("submit-approved-non-additive");
  const recordPath = join(s.binding.recordsRoot, "checkout-api.md");
  const before = await readFile(recordPath, "utf8");

  const candidateInput = {
    target_id: "checkout-api",
    source: "flag-cleanup",
    remove_claims: [
      "Feature flag checkout.newPricingEngine is at 100% in the config map but the old pricing engine code path has not been deleted, so both are live dependencies. [source: code-audit-118]",
    ],
  };

  const preview = await submitCandidate({ binding: s.binding, candidateInput, approve: false, submittedAt: "2026-08-02" });
  assert.equal(preview.status, "approval_required");
  if (preview.status !== "approval_required") return;

  const result = await submitCandidate({
    binding: s.binding,
    candidateInput,
    approve: true,
    expectHash: preview.plan_hash,
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.equal(result.classification, "non-additive");
  assert.equal(result.refresh.count, 1);

  const written = await readFile(recordPath, "utf8");
  assert.notEqual(written, before);
  assert.doesNotMatch(written, /checkout\.newPricingEngine is at 100%/);
});

test("approve without --expect is refused as invalid, not silently committed", async () => {
  const s = await space("submit-approve-without-expect");

  const result = await submitCandidate({
    binding: s.binding,
    candidateInput: {
      target_id: "checkout-api",
      source: "flag-cleanup",
      remove_claims: [
        "Feature flag checkout.newPricingEngine is at 100% in the config map but the old pricing engine code path has not been deleted, so both are live dependencies. [source: code-audit-118]",
      ],
    },
    approve: true,
    // expectHash intentionally omitted
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "invalid");
  if (result.status !== "invalid") return;
  assert.ok(result.errors.some((e) => e.includes("--expect")));
});

test("approving with a stale hash (record changed since the diff was shown) is refused as stale_approval, not committed", async () => {
  const s = await space("submit-stale-approval");
  const recordPath = join(s.binding.recordsRoot, "checkout-api.md");

  const candidateInput = {
    target_id: "checkout-api",
    source: "flag-cleanup",
    remove_claims: [
      "Feature flag checkout.newPricingEngine is at 100% in the config map but the old pricing engine code path has not been deleted, so both are live dependencies. [source: code-audit-118]",
    ],
  };

  const preview = await submitCandidate({ binding: s.binding, candidateInput, approve: false, submittedAt: "2026-08-02" });
  assert.equal(preview.status, "approval_required");
  if (preview.status !== "approval_required") return;

  // Someone else committed a different change to the same record in between.
  const otherChange = await submitCandidate({
    binding: s.binding,
    candidateInput: {
      target_id: "checkout-api",
      source: "unrelated",
      add_claims: ["An unrelated additive claim landed first."],
    },
    approve: false,
    submittedAt: "2026-08-02",
  });
  assert.equal(otherChange.status, "committed");

  const bytesBeforeStaleApprove = await readFile(recordPath);

  const result = await submitCandidate({
    binding: s.binding,
    candidateInput,
    approve: true,
    expectHash: preview.plan_hash, // now stale
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "stale_approval");
  if (result.status !== "stale_approval") return;
  assert.equal(result.expected_plan_hash, preview.plan_hash);
  assert.notEqual(result.actual_plan_hash, preview.plan_hash);
  assert.equal(result.refresh.attempted, false);
  assert.equal(result.refresh.count, 0);

  const bytesAfterStaleApprove = await readFile(recordPath);
  assert.ok(bytesBeforeStaleApprove.equals(bytesAfterStaleApprove), "a stale approval must not write anything");
});

// Required test #2: refresh failure after a valid write leaves the
// committed Markdown intact and reports index-stale.
test("a refresh failure after a valid write leaves the committed Markdown intact and reports index-stale", async () => {
  const s = await space("submit-refresh-failure");
  const recordPath = join(s.binding.recordsRoot, "ledger-reconciler.md");
  const qmdCacheSubdir = join(s.binding.qmdCacheHome, "qmd");

  // Make qmd's own cache/index directory AND the sqlite files inside it
  // unwritable so `qmd update` reliably fails (SQLITE_READONLY) after our
  // atomic write to the Markdown record — which lives under a different,
  // unaffected directory — has already succeeded. SQLite needs write
  // permission on the files themselves, not just the containing
  // directory, so both are covered here.
  await chmodDirAndContents(qmdCacheSubdir, 0o500);
  try {
    const result = await submitCandidate({
      binding: s.binding,
      candidateInput: {
        target_id: "ledger-reconciler",
        source: "access-remediation",
        add_claims: ["The reconciler's S3 access was scoped down to the settlement-files prefix."],
        add_evidence: [{ date: "2026-08-02", text: "S3 policy narrowed to a single prefix." }],
      },
      approve: false,
      submittedAt: "2026-08-02",
    });

    assert.equal(result.status, "committed");
    if (result.status !== "committed") return;
    assert.equal(result.classification, "additive");
    assert.equal(result.refresh.attempted, true);
    assert.equal(result.refresh.count, 1);
    assert.equal(result.refresh.state, "index-stale");

    const written = await readFile(recordPath, "utf8");
    assert.match(written, /The reconciler's S3 access was scoped down to the settlement-files prefix\./);
    assert.match(written, /updated: 2026-08-02/);
  } finally {
    await chmodDirAndContents(qmdCacheSubdir, 0o700);
  }
});

// Item 12 of the adversarial review: a directory-fsync failure AFTER a
// successful rename must produce a structured, schema-versioned result —
// not an uncaught exception with raw stderr.
test("a post-rename directory-fsync failure reports committed + index-stale, with refresh never attempted", async () => {
  const s = await space("submit-post-rename-fsync-failure");
  const recordPath = join(s.binding.recordsRoot, "payments-gateway.md");

  const result = await submitCandidate({
    binding: s.binding,
    candidateInput: {
      target_id: "payments-gateway",
      source: "x",
      add_claims: ["A claim written via the simulated fsync-failure path."],
    },
    approve: false,
    submittedAt: "2026-08-02",
    writeRecord: async (targetPath, content) => {
      // Genuinely perform the write — this is what "the record is already
      // replaced" means — then simulate the directory fsync failing.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(targetPath, content, "utf8");
      throw new AtomicWriteDirectorySyncError("simulated directory fsync failure", new Error("simulated ENOSPC"));
    },
  });

  assert.equal(result.schema_version, 0);
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.equal(result.refresh.attempted, false);
  assert.equal(result.refresh.count, 0);
  assert.equal(result.refresh.state, "index-stale");

  const written = await readFile(recordPath, "utf8");
  assert.match(written, /A claim written via the simulated fsync-failure path\./);
});

// Item 10 of the adversarial review: production code, not just test
// setup, must be able to bring up a fresh binding's qmd collection.
test("a genuinely fresh binding (qmd collection never registered) is auto-bootstrapped and reports fresh, not stale", async () => {
  const fresh = await createUninitializedEphemeralSpace(SPACE_A_RECORDS_DIR, "submit-auto-bootstrap");
  spacesToClean.push(fresh);

  const result = await submitCandidate({
    binding: fresh.binding,
    candidateInput: {
      target_id: "payments-gateway",
      source: "x",
      add_claims: ["First-ever write against a brand-new binding."],
    },
    approve: false,
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.equal(result.refresh.state, "fresh");
  assert.equal(result.refresh.count, 1);
});

test("an invalid candidate (unknown record id) is rejected without writing or refreshing", async () => {
  const s = await space("submit-invalid-unknown-id");

  const result = await submitCandidate({
    binding: s.binding,
    candidateInput: {
      target_id: "does-not-exist",
      source: "x",
      add_claims: ["irrelevant"],
    },
    approve: false,
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "invalid");
  if (result.status !== "invalid") return;
  assert.ok(result.errors.some((e) => e.includes("does-not-exist")));
  assert.equal(result.refresh.count, 0);
});

test("removing a claim that does not exist in the record is rejected as invalid", async () => {
  const s = await space("submit-invalid-remove-target");

  const result = await submitCandidate({
    binding: s.binding,
    candidateInput: {
      target_id: "payments-gateway",
      source: "x",
      remove_claims: ["This claim text was never in the record."],
    },
    approve: true,
    expectHash: "irrelevant-because-validation-fails-first",
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "invalid");
  if (result.status !== "invalid") return;
  assert.equal(result.refresh.count, 0);
});

// Cycle-two review: the record-only hash detected a changed record but did
// NOT bind approval to the mutation. These are the tests that fail against
// that defect — they deliberately approve something OTHER than what was
// previewed, which the earlier tests could not catch because they reused the
// identical candidate object for both calls.

test("approving a DIFFERENT candidate with the previewed plan_hash is refused, not committed", async () => {
  const s = await space("submit-swapped-candidate");
  const recordPath = join(s.binding.recordsRoot, "checkout-api.md");

  const previewedCandidate = {
    target_id: "checkout-api",
    source: "flag-cleanup",
    remove_claims: [
      "Feature flag checkout.newPricingEngine is at 100% in the config map but the old pricing engine code path has not been deleted, so both are live dependencies. [source: code-audit-118]",
    ],
  };

  const preview = await submitCandidate({
    binding: s.binding,
    candidateInput: previewedCandidate,
    approve: false,
    submittedAt: "2026-08-02",
  });
  assert.equal(preview.status, "approval_required");
  if (preview.status !== "approval_required") return;

  const bytesBefore = await readFile(recordPath);

  // The record is untouched, so a record-only hash still matches. The
  // mutation, however, is a completely different one.
  const swappedCandidate = {
    target_id: "checkout-api",
    source: "flag-cleanup",
    remove_claims: [
      "The readiness probe hits /healthz, which returns 200 even while the connection pool to the ledger service is exhausted, so rollouts can promote a pod that immediately errors under load. [source: incident-3390]",
    ],
  };

  const result = await submitCandidate({
    binding: s.binding,
    candidateInput: swappedCandidate,
    approve: true,
    expectHash: preview.plan_hash,
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "stale_approval");
  if (result.status !== "stale_approval") return;
  assert.equal(result.expected_plan_hash, preview.plan_hash);
  assert.notEqual(result.actual_plan_hash, preview.plan_hash);
  assert.equal(result.refresh.count, 0);

  const bytesAfter = await readFile(recordPath);
  assert.ok(bytesBefore.equals(bytesAfter), "a swapped candidate must not commit under the previewed hash");
});

test("approving at a different submission date than previewed is refused when the date changes the plan", async () => {
  const s = await space("submit-date-shift");
  const recordPath = join(s.binding.recordsRoot, "checkout-api.md");

  const candidateInput = {
    target_id: "checkout-api",
    source: "flag-cleanup",
    remove_claims: [
      "Feature flag checkout.newPricingEngine is at 100% in the config map but the old pricing engine code path has not been deleted, so both are live dependencies. [source: code-audit-118]",
    ],
  };

  const preview = await submitCandidate({
    binding: s.binding,
    candidateInput,
    approve: false,
    submittedAt: "2026-08-02",
  });
  assert.equal(preview.status, "approval_required");
  if (preview.status !== "approval_required") return;

  const bytesBefore = await readFile(recordPath);

  const result = await submitCandidate({
    binding: s.binding,
    candidateInput,
    approve: true,
    expectHash: preview.plan_hash,
    submittedAt: "2026-08-03",
  });

  assert.equal(result.status, "stale_approval");
  if (result.status !== "stale_approval") return;

  const bytesAfter = await readFile(recordPath);
  assert.ok(bytesBefore.equals(bytesAfter), "a date-shifted plan must not commit under the previewed hash");
});

// Cycle-three review: before/after text alone does not identify a mutation.
// Two spaces seeded from the same fixtures hold byte-identical records, so the
// same textual transition previewed in one space would otherwise approve the
// commit in the other after a binding change.

test("a plan_hash previewed in one space does not approve the identical transition in another", async () => {
  const previewSpace = await space("submit-destination-preview");
  const otherSpace = await space("submit-destination-other");

  const previewRecord = join(previewSpace.binding.recordsRoot, "checkout-api.md");
  const otherRecord = join(otherSpace.binding.recordsRoot, "checkout-api.md");

  const previewBytes = await readFile(previewRecord);
  const otherBytes = await readFile(otherRecord);
  assert.ok(
    previewBytes.equals(otherBytes),
    "precondition: both spaces must hold byte-identical records for this to test destination binding",
  );

  const candidateInput = {
    target_id: "checkout-api",
    source: "flag-cleanup",
    remove_claims: [
      "Feature flag checkout.newPricingEngine is at 100% in the config map but the old pricing engine code path has not been deleted, so both are live dependencies. [source: code-audit-118]",
    ],
  };

  const preview = await submitCandidate({
    binding: previewSpace.binding,
    candidateInput,
    approve: false,
    submittedAt: "2026-08-02",
  });
  assert.equal(preview.status, "approval_required");
  if (preview.status !== "approval_required") return;

  const result = await submitCandidate({
    binding: otherSpace.binding,
    candidateInput,
    approve: true,
    expectHash: preview.plan_hash,
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "stale_approval");
  if (result.status !== "stale_approval") return;
  assert.equal(result.refresh.count, 0);

  const otherAfter = await readFile(otherRecord);
  assert.ok(otherBytes.equals(otherAfter), "the other space's record must be untouched");
});
