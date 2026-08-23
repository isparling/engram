// Artifact-root-confined atomic replacement. Every confinement boundary gets
// a dedicated test: normal replacement, byte-identical no-op, relative ".."
// escape, root outside the active writeRoots, parent-directory symlink escape,
// a symlinked target, and a write failure that leaves previous bytes intact.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { registerSpace, resolveActiveSpace, selectSpace } from "../src/spaceRegistry.ts";
import type { ActiveSpace } from "../src/spaceRegistry.ts";
import { replaceArtifact } from "../src/artifactReplacement.ts";
import {
  createUninitializedEphemeralSpace,
  destroyEphemeralSpace,
  SPACE_A_RECORDS_DIR,
  writeLocalBindingFixture,
  type EphemeralSpace,
} from "./testSupport.ts";

const SPACE_ID = "artifact-space";
const HOST_SESSION_ID = "artifact-host-session";

const spacesToClean: EphemeralSpace[] = [];
const scratchDirsToClean: string[] = [];

after(async () => {
  for (const space of spacesToClean) {
    // Tests that simulate read-only directories must restore write access
    // themselves; this is a best-effort safety net.
    await chmod(space.root, 0o700).catch(() => {});
    await destroyEphemeralSpace(space);
  }
  for (const dir of scratchDirsToClean) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function prepareArtifactSpace(): Promise<{ space: EphemeralSpace; active: ActiveSpace }> {
  const space = await createUninitializedEphemeralSpace(SPACE_A_RECORDS_DIR, "artifact-replacement");
  spacesToClean.push(space);

  const registryPath = join(space.root, "registry.json");
  const bindingPath = await writeLocalBindingFixture(space, SPACE_ID);
  const registered = await registerSpace(registryPath, bindingPath);
  assert.equal(registered.ok, true);
  const selected = await selectSpace(registryPath, SPACE_ID, HOST_SESSION_ID);
  assert.equal(selected.ok, true);

  const active = await resolveActiveSpace({
    ENGRAM_BINDING_REGISTRY: registryPath,
    ENGRAM_HOST_SESSION_ID: HOST_SESSION_ID,
  });
  assert.equal(active.ok, true);
  if (!active.ok) throw new Error("expected an active space");
  return { space, active: active.value };
}

test("replaceArtifact writes new content atomically and reports the joined path", async () => {
  const { space, active } = await prepareArtifactSpace();
  const artifactRoot = join(space.root, "artifacts");
  await mkdir(artifactRoot, { recursive: true });

  const replaced = await replaceArtifact(active, {
    root: artifactRoot,
    relativePath: "prescriptions/build.yaml",
    content: "generated\n",
  });
  assert.deepEqual(replaced, {
    ok: true,
    value: { status: "replaced", path: join(artifactRoot, "prescriptions", "build.yaml") },
  });
  assert.equal(await readFile(join(artifactRoot, "prescriptions", "build.yaml"), "utf8"), "generated\n");
});

test("replaceArtifact is a byte-identical no-op when current content already matches", async () => {
  const { space, active } = await prepareArtifactSpace();
  const artifactRoot = join(space.root, "artifacts");
  await mkdir(artifactRoot, { recursive: true });

  const target = join(artifactRoot, "views", "consultations.md");
  const first = await replaceArtifact(active, {
    root: artifactRoot,
    relativePath: "views/consultations.md",
    content: "# Consultations\n",
  });
  assert.equal(first.ok, true);
  if (!first.ok || first.value.status !== "replaced") throw new Error("expected first write to replace");
  const before = await readFile(target, "utf8");

  const second = await replaceArtifact(active, {
    root: artifactRoot,
    relativePath: "views/consultations.md",
    content: "# Consultations\n",
  });
  assert.deepEqual(second, {
    ok: true,
    value: { status: "unchanged", path: join(artifactRoot, "views", "consultations.md") },
  });
  assert.equal(await readFile(target, "utf8"), before);
});

test("replaceArtifact rejects a relative path that escapes the requested root with ..", async () => {
  const { space, active } = await prepareArtifactSpace();
  const artifactRoot = join(space.root, "artifacts");
  await mkdir(artifactRoot, { recursive: true });

  const result = await replaceArtifact(active, {
    root: artifactRoot,
    relativePath: "../escape.yaml",
    content: "should not be written\n",
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection of .. escape");
  assert.equal(await readFile(join(space.root, "escape.yaml"), "utf8").catch(() => "(absent)"), "(absent)");
});

test("replaceArtifact rejects a root outside the active writeRoots", async () => {
  const { active } = await prepareArtifactSpace();
  const outsideDir = await mkdtemp(join(tmpdir(), "engram-artifact-outside-"));
  scratchDirsToClean.push(outsideDir);

  const result = await replaceArtifact(active, {
    root: outsideDir,
    relativePath: "out.md",
    content: "outside the binding\n",
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection of a root outside writeRoots");
  assert.equal(await readFile(join(outsideDir, "out.md"), "utf8").catch(() => "(absent)"), "(absent)");
});

test("replaceArtifact rejects a parent-directory symlink that resolves outside the requested root", async () => {
  const { space, active } = await prepareArtifactSpace();
  const artifactRoot = join(space.root, "artifacts");
  // The symlink points INSIDE the space (so writeRoot confinement alone would
  // allow it) but OUTSIDE the pack-selected artifact root — only per-parent
  // resolution against the canonicalized root can catch this escape.
  const elsewhere = join(space.root, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await symlink(elsewhere, join(artifactRoot, "escape-dir"));

  const result = await replaceArtifact(active, {
    root: artifactRoot,
    relativePath: "escape-dir/x.yaml",
    content: "escaped\n",
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection of a parent-directory symlink escape");
});

test("replaceArtifact rejects a symlinked target instead of writing through it", async () => {
  const { space, active } = await prepareArtifactSpace();
  const artifactRoot = join(space.root, "artifacts");
  const elsewhere = join(space.root, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await symlink(join(elsewhere, "target.yaml"), join(artifactRoot, "link.yaml"));

  const result = await replaceArtifact(active, {
    root: artifactRoot,
    relativePath: "link.yaml",
    content: "must not follow the symlink\n",
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection of a symlinked target");
  assert.equal(await readFile(join(elsewhere, "target.yaml"), "utf8").catch(() => "(absent)"), "(absent)");
});

test("replaceArtifact fails without disturbing previous artifact bytes when the write itself fails", async () => {
  const { space, active } = await prepareArtifactSpace();
  const artifactRoot = join(space.root, "artifacts");
  await mkdir(artifactRoot, { recursive: true });

  const target = join(artifactRoot, "stable.yaml");
  const initial = await replaceArtifact(active, {
    root: artifactRoot,
    relativePath: "stable.yaml",
    content: "previous bytes\n",
  });
  assert.equal(initial.ok, true);

  await chmod(artifactRoot, 0o500);
  try {
    const failed = await replaceArtifact(active, {
      root: artifactRoot,
      relativePath: "stable.yaml",
      content: "replacement that must not land\n",
    });
    assert.equal(failed.ok, false);
    if (failed.ok) throw new Error("expected the read-only write to fail");
    assert.equal(await readFile(target, "utf8"), "previous bytes\n");
  } finally {
    await chmod(artifactRoot, 0o700);
  }
});
