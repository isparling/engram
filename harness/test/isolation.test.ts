// Required test #4: a second synthetic space cannot be addressed — neither
// the caller nor the candidate can select another knowledge root or qmd
// collection.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { submitCandidate } from "../src/submit.ts";
import {
  createEphemeralSpace,
  destroyEphemeralSpace,
  SPACE_A_RECORDS_DIR,
  SPACE_B_RECORDS_DIR,
  type EphemeralSpace,
} from "./testSupport.ts";

let spaceA: EphemeralSpace;
let spaceB: EphemeralSpace;

after(async () => {
  if (spaceA) await destroyEphemeralSpace(spaceA);
  if (spaceB) await destroyEphemeralSpace(spaceB);
});

async function ensureSpaces(): Promise<void> {
  if (!spaceA) spaceA = await createEphemeralSpace(SPACE_A_RECORDS_DIR, "isolation-space-a");
  if (!spaceB) spaceB = await createEphemeralSpace(SPACE_B_RECORDS_DIR, "isolation-space-b");
}

test("a candidate cannot address a record that only exists in the other space by id alone", async () => {
  await ensureSpaces();

  const result = await submitCandidate({
    binding: spaceA.binding,
    candidateInput: {
      // notification-relay only exists in space B's fixtures.
      target_id: "notification-relay",
      source: "x",
      add_claims: ["should never land anywhere"],
    },
    approve: false,
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "invalid");
  if (result.status !== "invalid") return;
  assert.ok(result.errors.some((e) => e.includes("notification-relay")));
});

test("a candidate cannot smuggle a pointer at another root or collection through unexpected JSON fields", async () => {
  await ensureSpaces();

  const result = await submitCandidate({
    binding: spaceA.binding,
    candidateInput: {
      target_id: "payments-gateway",
      source: "x",
      add_claims: ["irrelevant"],
      // Neither of these fields exists in the Candidate type; the strict
      // validator must reject the whole candidate rather than silently
      // ignore them.
      recordsRoot: spaceB.binding.recordsRoot,
      qmdCollectionName: spaceB.binding.qmdCollectionName,
    },
    approve: false,
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "invalid");
  if (result.status !== "invalid") return;
  assert.ok(result.errors.some((e) => e.includes("recordsRoot")));
  assert.ok(result.errors.some((e) => e.includes("qmdCollectionName")));
});

test("a path-traversal-shaped target_id cannot escape the bound records root", async () => {
  await ensureSpaces();

  const result = await submitCandidate({
    binding: spaceA.binding,
    candidateInput: {
      target_id: "../space-b/records/notification-relay",
      source: "x",
      add_claims: ["irrelevant"],
    },
    approve: false,
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "invalid");
});

test("each space's qmd config lists only its own collection, never the other space's", async () => {
  await ensureSpaces();

  const configA = await readFile(`${spaceA.binding.qmdConfigDir}/index.yml`, "utf8");
  const configB = await readFile(`${spaceB.binding.qmdConfigDir}/index.yml`, "utf8");

  assert.match(configA, /isolation-space-a/);
  assert.doesNotMatch(configA, /isolation-space-b/);

  assert.match(configB, /isolation-space-b/);
  assert.doesNotMatch(configB, /isolation-space-a/);
});

test("a submit bound to space A only ever touches files under space A's records root", async () => {
  await ensureSpaces();

  const result = await submitCandidate({
    binding: spaceA.binding,
    candidateInput: {
      target_id: "payments-gateway",
      source: "x",
      add_claims: ["A claim used only to prove write scoping."],
    },
    approve: false,
    submittedAt: "2026-08-02",
  });

  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.ok(result.written_path.startsWith(spaceA.binding.recordsRoot));
  assert.ok(!result.written_path.startsWith(spaceB.binding.recordsRoot));
});
