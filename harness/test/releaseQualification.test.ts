import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isDefaultQmdCacheHome, isDefaultQmdConfigDir } from "../src/qmdConfigGuard.ts";
import { parseReleaseRecord } from "../../release/engram-release.ts";
import { qualifyAndPublishR0, type QualificationCommandResult, type QualificationOutput, type QualificationResult, type QualificationRunner } from "../scripts/release.ts";
import {
  buildRealSpaceStatusFixture,
  createStubbedGateRunner,
  createSyntheticReleaseSource,
  createSyntheticReleaseSourceWithTrackedLeafSymlink,
  destroyQualificationScratch,
  destroySyntheticReleaseSource,
  prepareQualifiableSource,
  qualifySyntheticRelease,
  type SyntheticReleaseSource,
  type SyntheticSpaceStatusFixture,
} from "./releaseTestSupport.ts";

const execFileAsync = promisify(execFileCallback);

const sources: SyntheticReleaseSource[] = [];
const scratchDirs: string[] = [];

after(async () => {
  await destroyQualificationScratch();
  await Promise.all(sources.map(destroySyntheticReleaseSource));
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function freshScratch(prefix: string): Promise<{ qualificationRoot: string; outputRoot: string }> {
  const qualificationRoot = await mkdtemp(join(tmpdir(), `engram-r0-${prefix}-root-`));
  const outputRoot = await mkdtemp(join(tmpdir(), `engram-r0-${prefix}-output-`));
  scratchDirs.push(qualificationRoot, outputRoot);
  return { qualificationRoot, outputRoot };
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Qualification with the packaged `engram space status` output replaced by
// the real `SpaceRegistryStatus` projection (built fresh from the registry
// and binding files release.ts wrote for the synthetic space) after
// `mutate` perturbs it. Everything else runs through the standard stub.
async function qualifyWithMutatedSpaceStatus(
  prefix: string,
  mutate: (fixture: SyntheticSpaceStatusFixture) => void,
): Promise<QualificationResult<QualificationOutput>> {
  const source = await prepareQualifiableSource();
  sources.push(source);
  const stub = createStubbedGateRunner();
  const runner: QualificationRunner = async (command, args, options) => {
    if (command.endsWith("/engram") && args[0] === "space" && args[1] === "status") {
      const registryPath = options.env.ENGRAM_BINDING_REGISTRY;
      const hostSessionId = options.env.ENGRAM_HOST_SESSION_ID;
      if (typeof registryPath !== "string" || typeof hostSessionId !== "string") {
        return { code: 1, stdout: "", stderr: "missing scoped space environment\n" };
      }
      const fixture = await buildRealSpaceStatusFixture(registryPath, hostSessionId);
      mutate(fixture);
      return { code: 0, stdout: JSON.stringify(fixture.status), stderr: "" };
    }
    return stub(command, args, options);
  };
  const { qualificationRoot, outputRoot } = await freshScratch(prefix);
  return qualifyAndPublishR0({ repoRoot: source.root, qualificationRoot, outputRoot, manualContentReview: "passed", runner });
}

// Release evidence is bound to the exact archive checksum and the source
// revision it was built from.
test("property: release evidence is bound to the exact artifact and source revision", async () => {
  const result = await qualifySyntheticRelease();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const record = parseReleaseRecord(JSON.parse(await readFile(result.value.recordPath, "utf8")));
  assert.equal(record.ok, true);
  if (!record.ok) return;
  assert.equal(record.value.verification_summary.every(
    (entry) => entry.artifact_sha256 === record.value.artifact_integrity.archive.sha256,
  ), true);
});

test("property: the record names included_beads as empty and the absent benchmark as a known limitation", async () => {
  const result = await qualifySyntheticRelease();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const record = parseReleaseRecord(JSON.parse(await readFile(result.value.recordPath, "utf8")));
  assert.equal(record.ok, true);
  if (!record.ok) return;
  assert.deepEqual(record.value.included_beads, []);
  assert.equal(record.value.known_limitations.some((limitation) => /benchmark/i.test(limitation)), true);
  const benchmarkEntry = record.value.verification_summary.find((entry) => /benchmark/i.test(entry.command));
  assert.notEqual(benchmarkEntry, undefined);
  assert.equal(benchmarkEntry?.outcome, "not_applicable");
  assert.equal(benchmarkEntry?.artifact_sha256, record.value.artifact_integrity.archive.sha256);
  const focusedCommands = record.value.verification_summary.map((entry) => entry.command);
  assert.equal(focusedCommands.some((command) => command.includes("knowledgeTransaction.test.ts")), true);
  assert.equal(focusedCommands.some((command) => command.includes("spaceBinding.test.ts")), true);
  assert.equal(focusedCommands.some((command) => command.includes("spaceRegistry.test.ts")), true);
  assert.equal(focusedCommands.some((command) => command.includes("releaseManager.test.ts") && command.includes("install")), true);
  assert.equal(focusedCommands.includes("npm test"), true);
  assert.equal(focusedCommands.includes("npm run typecheck"), true);
  assert.equal(focusedCommands.includes("npm run mutation-check"), true);
  assert.equal(focusedCommands.some((command) => command.includes("releaseManager.test.ts") && command.includes("rollback")), true);
});

test("property: qualifying a synthetic release publishes exactly one three-file release set with matching hashes", async () => {
  const result = await qualifySyntheticRelease();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const entries = (await readdir(result.value.destination)).sort();
  assert.equal(entries.length, 3);
  assert.equal(entries.some((name) => name.endsWith(".tar.gz")), true);
  assert.equal(entries.some((name) => name.endsWith(".release.json")), true);
  assert.equal(entries.some((name) => name.endsWith(".ts") && !name.endsWith(".release.json")), true);

  const record = parseReleaseRecord(JSON.parse(await readFile(result.value.recordPath, "utf8")));
  assert.equal(record.ok, true);
  if (!record.ok) return;
  const archiveBytes = await readFile(result.value.archivePath);
  const bootstrapBytes = await readFile(result.value.bootstrapPath);
  assert.equal(sha256(archiveBytes), record.value.artifact_integrity.archive.sha256);
  assert.equal(sha256(bootstrapBytes), record.value.artifact_integrity.bootstrap.sha256);
});

test("property: the release CLI delegates a Bun invocation to Node before qualification", async () => {
  if (process.versions.bun === undefined) return;
  const scriptPath = fileURLToPath(new URL("../scripts/release.ts", import.meta.url));
  const wrapperDir = await mkdtemp(join(tmpdir(), "engram-node-wrapper-"));
  const markerPath = join(wrapperDir, "node-invoked");
  scratchDirs.push(wrapperDir);
  const nodePath = (await execFileAsync("node", ["-p", "process.execPath"])).stdout.trim();
  const wrapperPath = join(wrapperDir, "node");
  await writeFile(wrapperPath, `#!/bin/sh\nprintf '%s\\n' delegated > "$ENGRAM_NODE_MARKER"\nexec ${JSON.stringify(nodePath)} "$@"\n`, "utf8");
  await chmod(wrapperPath, 0o755);

  await assert.rejects(execFileAsync(process.execPath, [scriptPath, "--manual-content-review", "nope"], {
    env: { ...process.env, PATH: wrapperDir, ENGRAM_NODE_MARKER: markerPath },
  }));
  const nodeWasInvoked = await readFile(markerPath, "utf8").then(() => true, () => false);
  assert.equal(nodeWasInvoked, true);
});

test("property: a dirty source tree stops qualification before any gate command runs", async () => {
  const source = await createSyntheticReleaseSource();
  sources.push(source);
  await writeFile(join(source.root, "untracked-dirty.txt"), "dirty\n", "utf8");

  const calls: string[] = [];
  const runner: QualificationRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    return { code: 0, stdout: "", stderr: "" };
  };
  const { qualificationRoot, outputRoot } = await freshScratch("dirty");
  const result = await qualifyAndPublishR0({ repoRoot: source.root, qualificationRoot, outputRoot, manualContentReview: "passed", runner });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "source_invalid");
  assert.deepEqual(calls, []);
});

test("property: a failing gate command stops qualification before staging", async () => {
  const source = await prepareQualifiableSource();
  sources.push(source);
  const calls: string[] = [];
  const runner: QualificationRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "npm" && args[0] === "run" && args[1] === "typecheck") {
      return { code: 1, stdout: "", stderr: "synthetic typecheck failure" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const { qualificationRoot, outputRoot } = await freshScratch("gate-fail");
  const result = await qualifyAndPublishR0({ repoRoot: source.root, qualificationRoot, outputRoot, manualContentReview: "passed", runner });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "gate_failed");
  assert.deepEqual(calls, ["npm test", "npm run typecheck"]);
  await assert.rejects(readdir(join(qualificationRoot, "candidate")));
});

test("property: qualification commands run in the exact required order", async () => {
  const calls: string[] = [];
  const stub = createStubbedGateRunner();
  const recordingRunner: QualificationRunner = async (command, args, options) => {
    const result: QualificationCommandResult = await stub(command, args, options);
    calls.push([command, ...args].join(" "));
    return result;
  };
  const result = await qualifySyntheticRelease(recordingRunner);
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.errors));

  const expectedShape: readonly ((call: string) => boolean)[] = [
    (call) => call === "npm test",
    (call) => call === "npm run typecheck",
    (call) => call === "npm run mutation-check",
    (call) => call === "qmd status",
    (call) => call.startsWith("git worktree add --detach"),
    (call) => call.startsWith("git worktree remove --force"),
    (call) => /^node .* install /.test(call),
    (call) => /^node .* select /.test(call),
    (call) => call.endsWith("/engram space status"),
    (call) => call.endsWith("/engram-release current"),
    (call) => call.endsWith("/engram version"),
    (call) => call.endsWith("/engram version"),
    (call) => call.endsWith("/engram version"),
  ];
  assert.equal(calls.length, expectedShape.length, calls.join("\n"));
  for (const [index, matches] of expectedShape.entries()) {
    assert.equal(matches(calls[index] ?? ""), true, `call ${index} did not match expected shape: ${calls[index]}`);
  }
});

test("property: qmd status runs under a scoped synthetic binding with no update key, no default location, and no ambient leakage", async () => {
  const source = await prepareQualifiableSource();
  sources.push(source);
  const { qualificationRoot, outputRoot } = await freshScratch("qmd-env");

  let qmdChecked = false;
  const previousAmbient = process.env.QMD_CONFIG_DIR;
  process.env.QMD_CONFIG_DIR = "/tmp/ambient-poison-qmd-config";
  try {
    const runner: QualificationRunner = async (command, args, options) => {
      if (command === "qmd") {
        assert.deepEqual(args, ["status"]);
        const configDir = options.env.QMD_CONFIG_DIR;
        const cacheHome = options.env.XDG_CACHE_HOME;
        assert.equal(typeof configDir, "string");
        assert.equal(typeof cacheHome, "string");
        if (typeof configDir !== "string" || typeof cacheHome !== "string") return { code: 1, stdout: "", stderr: "" };
        assert.notEqual(configDir, "/tmp/ambient-poison-qmd-config");
        const canonicalRoot = await realpath(qualificationRoot);
        const canonicalConfig = await realpath(configDir);
        const canonicalCache = await realpath(cacheHome);
        assert.equal(canonicalConfig.startsWith(`${canonicalRoot}/`), true);
        assert.equal(canonicalCache.startsWith(`${canonicalRoot}/`), true);
        assert.equal(await isDefaultQmdConfigDir(configDir), false);
        assert.equal(await isDefaultQmdCacheHome(cacheHome), false);
        const configText = await readFile(join(configDir, "index.yml"), "utf8");
        assert.equal(/^[ \t]*update[ \t]*:/m.test(configText), false);
        const collectionName = configText.match(/^collections:\n {2}([^:\n]+):/)?.[1] ?? "unknown-collection";
        qmdChecked = true;
        return { code: 0, stdout: `QMD Status\n\nIndex: ${join(cacheHome, "qmd", "index.sqlite")}\n\nCollections\n  ${collectionName} (qmd://${collectionName}/)\n`, stderr: "" };
      }
      if (command === "npm") return { code: 0, stdout: "", stderr: "" };
      // Stop deliberately right after the qmd step is observed — this test
      // only cares about the environment the qmd probe ran under.
      return { code: 1, stdout: "", stderr: "synthetic stop after qmd" };
    };
    const result = await qualifyAndPublishR0({ repoRoot: source.root, qualificationRoot, outputRoot, manualContentReview: "passed", runner });
    assert.equal(qmdChecked, true);
    assert.equal(result.ok, false);
  } finally {
    if (previousAmbient === undefined) delete process.env.QMD_CONFIG_DIR;
    else process.env.QMD_CONFIG_DIR = previousAmbient;
  }
});

test("property: a malformed successful engram space status result is rejected", async () => {
  const source = await prepareQualifiableSource();
  sources.push(source);
  const stub = createStubbedGateRunner();
  const runner: QualificationRunner = async (command, args, options) => {
    if (command.endsWith("/engram") && args[0] === "space" && args[1] === "status") {
      return {
        code: 0,
        stdout: JSON.stringify({ schema_version: 0, registered_spaces: [], active_spaces: {}, last_boundary_error: null }),
        stderr: "",
      };
    }
    return stub(command, args, options);
  };
  const { qualificationRoot, outputRoot } = await freshScratch("bad-status");
  const result = await qualifyAndPublishR0({ repoRoot: source.root, qualificationRoot, outputRoot, manualContentReview: "passed", runner });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "stable_command_failed");
});

// The packaged `engram space status` must report exactly the real
// `SpaceRegistryStatus`/`ActiveSpaceStatus` contract (harness/src/spaceRegistry.ts),
// and `assertSyntheticSpaceStatus` (harness/scripts/release.ts) must enforce the
// meaningful bindings — not just a fixture-shaped key count. Each projection below
// is the genuine real shape with exactly one binding defect, and each must be
// refused with `stable_command_failed`.

test("property: a status projection naming a different active space is refused with stable_command_failed", async () => {
  const result = await qualifyWithMutatedSpaceStatus("status-foreign-active-space", (fixture) => {
    fixture.active.space_id = "some-other-space";
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "stable_command_failed");
});

test("property: a status projection with a foreign qmd collection is refused with stable_command_failed", async () => {
  const result = await qualifyWithMutatedSpaceStatus("status-foreign-collection", (fixture) => {
    const qmd = fixture.active.qmd;
    assert.ok(recordValue(qmd));
    qmd.collection = "some-other-collection";
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "stable_command_failed");
});

test("property: a status projection with any root outside the qualification root is refused with stable_command_failed", async () => {
  const outside = join(tmpdir(), "engram-r0-outside-qualification-root");
  const cases: { label: string; mutate: (fixture: SyntheticSpaceStatusFixture) => void }[] = [
    { label: "space_root", mutate: (fixture) => { fixture.active.space_root = outside; } },
    { label: "records_root", mutate: (fixture) => { fixture.active.records_root = outside; } },
    { label: "qmd.config_dir", mutate: (fixture) => { const qmd = fixture.active.qmd; assert.ok(recordValue(qmd)); qmd.config_dir = outside; } },
    { label: "qmd.cache_home", mutate: (fixture) => { const qmd = fixture.active.qmd; assert.ok(recordValue(qmd)); qmd.cache_home = outside; } },
    { label: "sessions_dir", mutate: (fixture) => { fixture.active.sessions_dir = outside; } },
    { label: "read_roots", mutate: (fixture) => { fixture.active.read_roots = [outside]; } },
    { label: "write_roots", mutate: (fixture) => { fixture.active.write_roots = [outside]; } },
  ];
  for (const { label, mutate } of cases) {
    const result = await qualifyWithMutatedSpaceStatus(`status-outside-${label.replaceAll(".", "-")}`, mutate);
    assert.equal(result.ok, false, `${label}: qualification unexpectedly succeeded`);
    if (result.ok) continue;
    assert.equal(result.errors[0]?.code, "stable_command_failed", label);
  }
});

test("property: a status projection with a wrong required field value is refused with stable_command_failed", async () => {
  const result = await qualifyWithMutatedSpaceStatus("status-wrong-field", (fixture) => {
    fixture.active.compatibility = "incompatible";
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "stable_command_failed");
});

test("property: a status projection missing a required field is refused with stable_command_failed", async () => {
  const result = await qualifyWithMutatedSpaceStatus("status-missing-field", (fixture) => {
    delete fixture.active.session_boundary;
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "stable_command_failed");
});

test("property: a staging failure removes its already-added detached worktree", async () => {
  const source = await createSyntheticReleaseSourceWithTrackedLeafSymlink();
  sources.push(source);
  const calls: string[] = [];
  const stub = createStubbedGateRunner();
  const runner: QualificationRunner = async (command, args, options) => {
    calls.push([command, ...args].join(" "));
    return stub(command, args, options);
  };
  const { qualificationRoot, outputRoot } = await freshScratch("staging-cleanup");
  const result = await qualifyAndPublishR0({ repoRoot: source.root, qualificationRoot, outputRoot, manualContentReview: "passed", runner });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "candidate_build_failed");
  const addedAt = calls.findIndex((call) => call.startsWith("git worktree add --detach"));
  const removedAt = calls.findIndex((call) => call.startsWith("git worktree remove --force"));
  assert.notEqual(addedAt, -1);
  assert.equal(removedAt > addedAt, true, calls.join("\n"));
});

test("property: an existing release destination is refused without being replaced", async () => {
  const source = await prepareQualifiableSource();
  sources.push(source);
  const stub = createStubbedGateRunner();

  const first = await freshScratch("existing-dest-1");
  const firstResult = await qualifyAndPublishR0({
    repoRoot: source.root,
    qualificationRoot: first.qualificationRoot,
    outputRoot: first.outputRoot,
    manualContentReview: "passed",
    runner: stub,
  });
  assert.equal(firstResult.ok, true);
  if (!firstResult.ok) return;

  const beforeArchive = await readFile(firstResult.value.archivePath);
  const beforeBootstrap = await readFile(firstResult.value.bootstrapPath);
  const beforeRecord = await readFile(firstResult.value.recordPath);
  const beforeEntries = (await readdir(firstResult.value.destination)).sort();

  // Same source (same commit) published into the same output root
  // resolves to the same release id and therefore the same destination.
  const second = await freshScratch("existing-dest-2");
  const secondResult = await qualifyAndPublishR0({
    repoRoot: source.root,
    qualificationRoot: second.qualificationRoot,
    outputRoot: first.outputRoot,
    manualContentReview: "passed",
    runner: stub,
  });
  assert.equal(secondResult.ok, false);
  if (secondResult.ok) return;
  assert.equal(secondResult.errors[0]?.code, "publication_exists");

  assert.deepEqual(await readFile(firstResult.value.archivePath), beforeArchive);
  assert.deepEqual(await readFile(firstResult.value.bootstrapPath), beforeBootstrap);
  assert.deepEqual(await readFile(firstResult.value.recordPath), beforeRecord);
  assert.deepEqual((await readdir(firstResult.value.destination)).sort(), beforeEntries);
});

test("the production CLI accepts only --manual-content-review passed", async () => {
  const scriptPath = fileURLToPath(new URL("../scripts/release.ts", import.meta.url));
  const badArgumentSets: readonly string[][] = [
    [],
    ["--manual-content-review"],
    ["--manual-content-review", "nope"],
    ["--other-flag", "passed"],
  ];
  for (const badArgs of badArgumentSets) {
    await assert.rejects(execFileAsync(process.execPath, [scriptPath, ...badArgs]));
  }
});

test("the production CLI still runs when release.ts is invoked through a symlink", async () => {
  const scriptPath = fileURLToPath(new URL("../scripts/release.ts", import.meta.url));
  const linkRoot = await mkdtemp(join(tmpdir(), "engram-r0-release-cli-link-"));
  scratchDirs.push(linkRoot);
  const linkedScript = join(linkRoot, "release.ts");
  await symlink(scriptPath, linkedScript);
  await assert.rejects(
    execFileAsync(process.execPath, [linkedScript, "--manual-content-review", "nope"]),
    (error: unknown) => error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr.includes("usage: release.ts"),
  );
});

test("property: an unrelated ambient variable cannot reach packaged smoke commands", async () => {
  const previous = process.env.ENGRAM_QUALIFICATION_AMBIENT_SENTINEL;
  process.env.ENGRAM_QUALIFICATION_AMBIENT_SENTINEL = "must-not-reach-packaged-smoke";
  try {
    const result = await qualifySyntheticRelease();
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.errors));
  } finally {
    if (previous === undefined) delete process.env.ENGRAM_QUALIFICATION_AMBIENT_SENTINEL;
    else process.env.ENGRAM_QUALIFICATION_AMBIENT_SENTINEL = previous;
  }
});

test("property: a qmd status probe whose output does not name the bound collection fails qualification with qmd_probe_failed", async () => {
  const source = await prepareQualifiableSource();
  sources.push(source);
  const calls: string[] = [];
  const runner: QualificationRunner = async (command, args, options) => {
    calls.push([command, ...args].join(" "));
    if (command === "npm") return { code: 0, stdout: "", stderr: "" };
    if (command === "qmd") {
      const cacheHome = options.env.XDG_CACHE_HOME;
      const indexPath = typeof cacheHome === "string" ? join(cacheHome, "qmd", "index.sqlite") : "/nowhere/index.sqlite";
      return {
        code: 0,
        stdout: `QMD Status\n\nIndex: ${indexPath}\n\nCollections\n  unrelated-collection (qmd://unrelated-collection/)\n`,
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  const { qualificationRoot, outputRoot } = await freshScratch("qmd-status-no-collection");
  const result = await qualifyAndPublishR0({ repoRoot: source.root, qualificationRoot, outputRoot, manualContentReview: "passed", runner });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "qmd_probe_failed");
  assert.equal(calls.some((call) => call.startsWith("git worktree add")), false);
});

test("property: a qmd status probe whose reported index path is outside the scoped cache home fails qualification with qmd_probe_failed", async () => {
  const source = await prepareQualifiableSource();
  sources.push(source);
  const calls: string[] = [];
  const runner: QualificationRunner = async (command, args, options) => {
    calls.push([command, ...args].join(" "));
    if (command === "npm") return { code: 0, stdout: "", stderr: "" };
    if (command === "qmd") {
      const configDir = options.env.QMD_CONFIG_DIR;
      const configText = typeof configDir === "string" ? await readFile(join(configDir, "index.yml"), "utf8") : "";
      const collectionName = configText.match(/^collections:\n {2}([^:\n]+):/)?.[1] ?? "unknown-collection";
      return {
        code: 0,
        stdout: `QMD Status\n\nIndex: /tmp/definitely-not-scoped/qmd/index.sqlite\n\nCollections\n  ${collectionName} (qmd://${collectionName}/)\n`,
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  const { qualificationRoot, outputRoot } = await freshScratch("qmd-status-escaped-index");
  const result = await qualifyAndPublishR0({ repoRoot: source.root, qualificationRoot, outputRoot, manualContentReview: "passed", runner });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "qmd_probe_failed");
  assert.equal(calls.some((call) => call.startsWith("git worktree add")), false);
});

test("property: a qmd status probe exiting nonzero stops qualification before any staging", async () => {
  const source = await prepareQualifiableSource();
  sources.push(source);
  const calls: string[] = [];
  const runner: QualificationRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "npm") return { code: 0, stdout: "", stderr: "" };
    if (command === "qmd") {
      // Mirrors the real installed CLI: `qmd --version` prints usage text
      // to stdout and exits 1 rather than reporting a version.
      return { code: 1, stdout: "Usage:\n  qmd collection add [path] --name <name> --mask <pattern>\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "should not run after qmd fails" };
  };
  const { qualificationRoot, outputRoot } = await freshScratch("qmd-status-nonzero");
  const result = await qualifyAndPublishR0({ repoRoot: source.root, qualificationRoot, outputRoot, manualContentReview: "passed", runner });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "qmd_probe_failed");
  assert.equal(calls.some((call) => call.startsWith("git worktree add")), false);
});

test("property: bootstrap install must emit only its exact success JSON", async () => {
  const source = await prepareQualifiableSource();
  sources.push(source);
  const stub = createStubbedGateRunner();
  const runner: QualificationRunner = async (command, args, options) => {
    if (command === "node" && args[1] === "install") {
      return { code: 0, stdout: JSON.stringify({ schema_version: 0, status: "installed", secret: "forbidden" }), stderr: "" };
    }
    return stub(command, args, options);
  };
  const { qualificationRoot, outputRoot } = await freshScratch("install-projection");
  const result = await qualifyAndPublishR0({ repoRoot: source.root, qualificationRoot, outputRoot, manualContentReview: "passed", runner });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "install_smoke_failed");
  assert.match(result.errors[0]?.message ?? "", /exact success projection/);
});

test("property: a source mutation during the gate suite aborts before qmd", async () => {
  const source = await prepareQualifiableSource();
  sources.push(source);
  const calls: string[] = [];
  const runner: QualificationRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "npm" && args[1] === "mutation-check") {
      await writeFile(join(source.root, "gate-mutation.txt"), "source changed during gate\n", "utf8");
    }
    return { code: 0, stdout: command === "qmd" ? "qmd synthetic-0\n" : "", stderr: "" };
  };
  const { qualificationRoot, outputRoot } = await freshScratch("post-gate-source");
  const result = await qualifyAndPublishR0({ repoRoot: source.root, qualificationRoot, outputRoot, manualContentReview: "passed", runner });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "source_invalid");
  assert.equal(calls.includes("qmd status"), false);
});

test("property: an empty destination raced in before the claim is refused without replacement", async () => {
  const source = await prepareQualifiableSource();
  sources.push(source);
  const { qualificationRoot, outputRoot } = await freshScratch("publication-race");
  const result = await qualifyAndPublishR0({
    repoRoot: source.root,
    qualificationRoot,
    outputRoot,
    manualContentReview: "passed",
    runner: createStubbedGateRunner(),
    hooks: {
      beforePublicationClaim: async (destination) => {
        await mkdir(destination);
      },
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.code, "publication_exists");
  const destinationEntries = await readdir(join(outputRoot, `r0-${source.revision}`));
  assert.deepEqual(destinationEntries, []);
});

test("property: the published record's qmd_compatibility.version is exactly unversioned-cli with a matching known limitation", async () => {
  const result = await qualifySyntheticRelease();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const record = parseReleaseRecord(JSON.parse(await readFile(result.value.recordPath, "utf8")));
  assert.equal(record.ok, true);
  if (!record.ok) return;
  assert.deepEqual(record.value.qmd_compatibility, { contract: "scoped-cli", version: "unversioned-cli" });
  assert.equal(
    record.value.known_limitations.some((limitation) => /qmd CLI exposes no version identifier/.test(limitation)),
    true,
  );
  const statusEntry = record.value.verification_summary.find((entry) => entry.command === "qmd status");
  assert.notEqual(statusEntry, undefined);
  assert.equal(statusEntry?.outcome, "passed");
  assert.equal(statusEntry?.artifact_sha256, record.value.artifact_integrity.archive.sha256);
});

test("property: a manifest carrying the former private compatibility label is rejected", async () => {
  const result = await qualifySyntheticRelease();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const raw = JSON.parse(await readFile(result.value.recordPath, "utf8")) as Record<string, unknown>;
  raw.qmd_compatibility = { contract: "D" + "-0" + "23-scoped-cli", version: "0.1.0" };
  const parsed = parseReleaseRecord(raw);
  assert.equal(parsed.ok, false);
});
