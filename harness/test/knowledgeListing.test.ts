// Guarded record listing: enumeration over the active space's records root
// (never qmd, never a caller-supplied filesystem root) plus exact in-memory
// pack.id and status filtering with deterministic record-ID ordering.
//
// The symlinked-record case pins the guard contract: a locator that escapes
// the records root must FAIL the whole listing — guarded retrieval reports the
// escape — rather than silently omitting the record it cannot confine.

import assert from "node:assert/strict";
import { readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { registerSpace, resolveActiveSpace, selectSpace } from "../src/spaceRegistry.ts";
import type { ActiveSpace } from "../src/spaceRegistry.ts";
import { serializeKnowledgeRecord } from "../src/knowledgeRecord.ts";
import type { KnowledgeRecord, KnowledgeStatus } from "../src/knowledgeTypes.ts";
import { listKnowledgeRecords } from "../src/knowledgeListing.ts";
import {
  createUninitializedEphemeralSpace,
  destroyEphemeralSpace,
  SPACE_A_RECORDS_DIR,
  writeLocalBindingFixture,
  type EphemeralSpace,
} from "./testSupport.ts";

const LISTING_SPACE_ID = "listing-space";
const HOST_SESSION_ID = "listing-host-session";

const spacesToClean: EphemeralSpace[] = [];

after(async () => {
  for (const space of spacesToClean) {
    await destroyEphemeralSpace(space);
  }
});

function fixtureRecord(id: string, packId: string, status: KnowledgeStatus): KnowledgeRecord {
  return {
    schemaVersion: 0,
    id,
    kind: "claim",
    status,
    statement: `Fixture statement for ${id}.`,
    details: {},
    scope: { space: LISTING_SPACE_ID, subjects: [], topics: [], contexts: [], dimensions: {} },
    pack: { id: packId, version: "0.1.0" },
    sources: [{ type: "fixture", ref: `fixture-${id}` }],
    session: { id: "listing-fixture-session", host: "engram-test" },
    submittedAt: "2026-08-22",
    disposition: "new",
    relationships: { supports: [], contradicts: [], refines: [], supersedes: [] },
    history: [],
  };
}

/**
 * Creates a registered, selected space whose records root starts EMPTY (the
 * copied space-a fixture records belong to a different space and would fail
 * the scope guard), then resolves the active space the way a host would.
 */
async function prepareListingSpace(): Promise<{ space: EphemeralSpace; active: ActiveSpace }> {
  const space = await createUninitializedEphemeralSpace(SPACE_A_RECORDS_DIR, "knowledge-listing");
  spacesToClean.push(space);
  for (const entry of await readdir(space.binding.recordsRoot)) {
    await rm(join(space.binding.recordsRoot, entry), { recursive: true, force: true });
  }

  const registryPath = join(space.root, "registry.json");
  const bindingPath = await writeLocalBindingFixture(space, LISTING_SPACE_ID);
  const registered = await registerSpace(registryPath, bindingPath);
  assert.equal(registered.ok, true);
  const selected = await selectSpace(registryPath, LISTING_SPACE_ID, HOST_SESSION_ID);
  assert.equal(selected.ok, true);

  const active = await resolveActiveSpace({
    ENGRAM_BINDING_REGISTRY: registryPath,
    ENGRAM_HOST_SESSION_ID: HOST_SESSION_ID,
  });
  assert.equal(active.ok, true);
  if (!active.ok) throw new Error("expected an active space");
  return { space, active: active.value };
}

async function seedRecord(recordsRoot: string, record: KnowledgeRecord): Promise<void> {
  await writeFile(join(recordsRoot, `${record.id}.md`), serializeKnowledgeRecord(record), "utf8");
}

test("listKnowledgeRecords filters exactly by pack id and status with deterministic record-ID ordering", async () => {
  const { space, active } = await prepareListingSpace();

  // Seed deliberately out of alphabetical order so ordering can only come
  // from the listing, never from insertion order.
  await seedRecord(space.binding.recordsRoot, fixtureRecord("retired-d", "project-status", "retired"));
  await seedRecord(space.binding.recordsRoot, fixtureRecord("other-e", "other-pack", "active"));
  await seedRecord(space.binding.recordsRoot, fixtureRecord("candidate-c", "project-status", "candidate"));
  await seedRecord(space.binding.recordsRoot, fixtureRecord("active-b", "project-status", "active"));
  await seedRecord(space.binding.recordsRoot, fixtureRecord("active-a", "project-status", "active"));

  const result = await listKnowledgeRecords(active, {
    packId: "project-status",
    statuses: ["active"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected guarded record list");
  assert.deepEqual(result.value.map((record) => record.id), ["active-a", "active-b"]);
});

test("listKnowledgeRecords honors multiple requested statuses and other packs without cross-contamination", async () => {
  const { space, active } = await prepareListingSpace();
  await seedRecord(space.binding.recordsRoot, fixtureRecord("retired-d", "project-status", "retired"));
  await seedRecord(space.binding.recordsRoot, fixtureRecord("other-e", "other-pack", "active"));
  await seedRecord(space.binding.recordsRoot, fixtureRecord("candidate-c", "project-status", "candidate"));

  const multiStatus = await listKnowledgeRecords(active, {
    packId: "project-status",
    statuses: ["candidate", "retired"],
  });
  assert.equal(multiStatus.ok, true);
  if (!multiStatus.ok) throw new Error("expected guarded record list");
  assert.deepEqual(multiStatus.value.map((record) => record.id), ["candidate-c", "retired-d"]);

  const otherPack = await listKnowledgeRecords(active, {
    packId: "other-pack",
    statuses: ["active"],
  });
  assert.equal(otherPack.ok, true);
  if (!otherPack.ok) throw new Error("expected guarded record list");
  assert.deepEqual(otherPack.value.map((record) => record.id), ["other-e"]);

  const noMatches = await listKnowledgeRecords(active, {
    packId: "project-status",
    statuses: ["contested"],
  });
  assert.equal(noMatches.ok, true);
  if (!noMatches.ok) throw new Error("expected guarded record list");
  assert.deepEqual(noMatches.value, []);
});

test("listKnowledgeRecords reports a guarded retrieval error for a symlinked record escaping the records root instead of silently omitting it", async () => {
  const { space, active } = await prepareListingSpace();
  await seedRecord(space.binding.recordsRoot, fixtureRecord("active-a", "project-status", "active"));
  await symlink(join(space.root, "binding.json"), join(space.binding.recordsRoot, "escape-md.md"));

  const result = await listKnowledgeRecords(active, {
    packId: "project-status",
    statuses: ["active"],
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected a guarded retrieval error");
  assert.ok(
    result.errors.some((error) => error.code === "path_escape"),
  );
});
