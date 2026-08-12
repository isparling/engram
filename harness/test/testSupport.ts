// Test-only helpers. Not part of the harness surface.
//
// Every ephemeral space is created fresh under the OS temp directory and
// destroyed after the test, so committed sqlite/cache state never lands in
// the repository. The fixture Markdown under harness/test-fixtures/ is
// copied in, never mutated in place.
//
// createEphemeralSpace calls qmd once, through runQmd — the same single
// spawn point production code uses — to register the fixture's collection.
// This is test setup, not a second qmd entry point: it is the same choke
// point, used to prepare fixtures instead of to refresh.

import { chmod, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runQmd } from "../src/qmdRunner.ts";
import type { SpaceBinding } from "../src/spaceBinding.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(TEST_DIR, "..", "test-fixtures");
export const SPACE_A_RECORDS_DIR = join(FIXTURES_DIR, "space-a", "records");
export const SPACE_B_RECORDS_DIR = join(FIXTURES_DIR, "space-b", "records");

export type EphemeralSpace = {
  binding: SpaceBinding;
  root: string;
};

/**
 * Creates an ephemeral space with its qmd collection already registered
 * (via runQmd — the same single spawn point production code uses). Most
 * tests want this: it isolates them from qmd's own collection-bootstrap
 * behavior so they can focus on submitCandidate's logic.
 */
export async function createEphemeralSpace(
  fixtureRecordsDir: string,
  collectionName: string,
): Promise<EphemeralSpace> {
  const { binding, root } = await createUninitializedEphemeralSpace(fixtureRecordsDir, collectionName);

  const setup = await runQmd(
    ["collection", "add", binding.recordsRoot, "--name", collectionName, "--mask", "*.md"],
    binding,
  );
  if (!setup.ranProcess || setup.code !== 0) {
    throw new Error(
      `failed to initialize test qmd collection '${collectionName}': ranProcess=${setup.ranProcess} code=${setup.code}\n${setup.stderr}`,
    );
  }

  return { binding, root };
}

/**
 * Creates an ephemeral space WITHOUT registering its qmd collection —
 * models a genuinely fresh binding that has never been used before, so
 * production code's own auto-bootstrap (qmdRunner.ensureBoundCollection,
 * item 10 of the adversarial review) can be exercised end to end.
 */
export async function createUninitializedEphemeralSpace(
  fixtureRecordsDir: string,
  collectionName: string,
): Promise<EphemeralSpace> {
  const root = await mkdtemp(join(tmpdir(), "engram-harness-test-"));
  const recordsRoot = join(root, "records");
  const qmdConfigDir = join(root, "qmd-config");
  const qmdCacheHome = join(root, "qmd-cache");

  await mkdir(recordsRoot, { recursive: true });
  await mkdir(qmdConfigDir, { recursive: true });
  await mkdir(qmdCacheHome, { recursive: true });
  await cp(fixtureRecordsDir, recordsRoot, { recursive: true });

  const binding: SpaceBinding = { recordsRoot, qmdConfigDir, qmdCacheHome, qmdCollectionName: collectionName };
  return { binding, root };
}

/**
 * chmod a directory and every entry directly inside it (non-recursive
 * beyond one level, which is all the qmd cache layout needs). Used to
 * simulate a read-only qmd index so refresh fails deterministically:
 * SQLite needs write permission on the .sqlite/-wal/-shm files
 * themselves, not just their containing directory, so both must be
 * covered for the failure to be reliable.
 */
export async function chmodDirAndContents(dir: string, mode: number): Promise<void> {
  const entries = await readdir(dir);
  for (const entry of entries) {
    await chmod(join(dir, entry), mode);
  }
  await chmod(dir, mode);
}

export async function destroyEphemeralSpace(space: EphemeralSpace): Promise<void> {
  // Tests that simulate a read-only cache directory must restore write
  // permission themselves before this runs; this is a best-effort safety
  // net so a forgotten restore does not leave junk in the OS temp dir.
  await chmod(space.root, 0o700).catch(() => {});
  await rm(space.root, { recursive: true, force: true }).catch(() => {});
}

export async function writeLocalBindingFixture(space: EphemeralSpace, spaceId: string): Promise<string> {
  const manifestPath = join(space.root, "space.json");
  const sessionsDir = join(space.root, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      schema_version: 0,
      space_id: spaceId,
      knowledge_schema_version: "0",
      records_dir: "records",
      required_packs: [{ id: "fictional-integrity", version: "0.1.0" }],
    }),
    "utf8",
  );

  const bindingPath = join(space.root, "binding.json");
  await writeFile(
    bindingPath,
    JSON.stringify({
      schema_version: 0,
      manifest_path: manifestPath,
      qmd_config_dir: space.binding.qmdConfigDir,
      qmd_cache_home: space.binding.qmdCacheHome,
      qmd_collection_name: space.binding.qmdCollectionName,
      sessions_dir: sessionsDir,
      read_roots: [space.root],
      write_roots: [space.root],
      provider_policy: {
        allowed_models: ["fictional-provider/fictional-model"],
        credential_env: ["FICTIONAL_PROVIDER_TOKEN"],
      },
      installed_packs: [{ id: "fictional-integrity", version: "0.1.0", from: join(TEST_DIR, "fictionalPack.ts") }],
    }),
    "utf8",
  );
  return bindingPath;
}
