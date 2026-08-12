import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mutations } from "../mutations.ts";
import { parseFailingTestNames, selectMutations } from "../scripts/mutation-check.ts";

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const temporaryRoots: string[] = [];

after(async () => {
  for (const root of temporaryRoots) {
    await rm(root, { recursive: true, force: true });
  }
});

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const found = text.indexOf(needle, offset);
    if (found === -1) break;
    count++;
    offset = found + needle.length;
  }
  return count;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

type SyntheticRepo = {
  root: string;
  harness: string;
  target: string;
};

async function createSyntheticRepo(
  registrySource: string,
  testSource = [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { value } from "../src/target.ts";',
    "",
    'test("synthetic target property remains true", () => {',
    '  assert.equal(value, "good");',
    "});",
    "",
  ].join("\n"),
  targetSource = 'export const value = "good";\n',
): Promise<SyntheticRepo> {
  const root = await mkdtemp(join(tmpdir(), "engram-mutation-check-test-"));
  temporaryRoots.push(root);
  const harness = join(root, "harness");
  const scripts = join(harness, "scripts");
  const source = join(harness, "src");
  const tests = join(harness, "test");
  await mkdir(scripts, { recursive: true });
  await mkdir(source, { recursive: true });
  await mkdir(tests, { recursive: true });
  await mkdir(join(root, "release"), { recursive: true });

  await writeFile(join(harness, "mutations.ts"), registrySource, "utf8");
  await writeFile(join(scripts, "mutation-check.ts"), await readFile(join(HARNESS_DIR, "scripts", "mutation-check.ts")), "utf8");
  const target = join(source, "target.ts");
  await writeFile(target, targetSource, "utf8");
  await writeFile(join(tests, "target.test.ts"), testSource, "utf8");

  git(root, ["init"]);
  git(root, ["config", "user.name", "Synthetic Mutation Tester"]);
  git(root, ["config", "user.email", "synthetic@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "synthetic mutation fixture"]);

  return { root, harness, target };
}

function runSyntheticScript(
  repo: SyntheticRepo,
  scriptPath: string,
  ids: string[] = [],
): { status: number | null; output: string } {
  const result = spawnSync(NODE, [scriptPath, ...ids], {
    cwd: repo.harness,
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function runSynthetic(repo: SyntheticRepo, ids: string[] = []): { status: number | null; output: string } {
  return runSyntheticScript(repo, join(repo.harness, "scripts", "mutation-check.ts"), ids);
}

test("the mutation registry contains exactly 96 registered core properties with one unique non-historical id and one source seam each", async () => {
  assert.equal(mutations.length, 96);
  assert.equal(new Set(mutations.map((mutation) => mutation.id)).size, 96);

  for (const mutation of mutations) {
    assert.match(mutation.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.doesNotMatch(mutation.id, /^m[3-5]-/);
    assert.ok(mutation.property.length > 0);
    assert.ok(mutation.find.length > 0);
    assert.ok(mutation.replace.length > 0);
    assert.ok(mutation.mustFail.length > 0);
    const filePath = join(HARNESS_DIR, mutation.file);
    assert.equal(existsSync(filePath), true, `${mutation.id} must target an existing core file`);
    const source = await readFile(filePath, "utf8");
    assert.equal(countOccurrences(source, mutation.find), 1, `${mutation.id} must pin one exact source seam`);
  }

  const classification = mutations.find((mutation) => mutation.id === "classification-from-plan");
  assert.ok(classification);
  if (!classification) return;
  assert.match(classification.property, /injected|wiring/i);
  assert.match(classification.find, /contentPreserved/);
});

test("positional mutation IDs select a registry-order subset and report unknown IDs", () => {
  const selected = selectMutations(["refresh-exactly-once", "approval-binds-plan"]);
  assert.deepEqual(selected.mutations.map((mutation) => mutation.id), ["approval-binds-plan", "refresh-exactly-once"]);
  assert.deepEqual(selected.unknownIds, []);

  const unknown = selectMutations(["not-a-seed"]);
  assert.deepEqual(unknown.mutations, []);
  assert.deepEqual(unknown.unknownIds, ["not-a-seed"]);
});

test("the runner rejects an unknown positional mutation ID instead of silently running nothing", async () => {
  const registry = [
    "export const mutations = [{",
    '  id: "synthetic-target", property: "synthetic target property", file: "src/target.ts",',
    '  find: \'export const value = "good";\', replace: \'export const value = "bad";\',',
    '  mustFail: ["synthetic target property"],',
    "}];",
    "",
  ].join("\n");
  const repo = await createSyntheticRepo(registry);

  const result = runSynthetic(repo, ["not-a-seed"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /unknown mutation id/);
  assert.doesNotMatch(result.output, /baseline: PASS|summary:/);
  assert.equal(await readFile(repo.target, "utf8"), 'export const value = "good";\n');
});

test("the runner accepts --id for one isolated mutation", async () => {
  const registry = [
    "export const mutations = [{",
    '  id: "synthetic-target", property: "synthetic target property", file: "src/target.ts",',
    '  find: \'export const value = "good";\', replace: \'export const value = "bad";\',',
    '  mustFail: ["synthetic target property remains true"],',
    "}];",
    "",
  ].join("\n");
  const repo = await createSyntheticRepo(registry);

  const result = runSynthetic(repo, ["--id", "synthetic-target"]);
  assert.equal(result.status, 0);
  assert.match(result.output, /baseline: PASS/);
  assert.match(result.output, /PASS synthetic-target/);
  assert.match(result.output, /summary: 1\/1 mutations passed/);
});

test("Node TAP output yields failing test names from top-level and indented not-ok lines", () => {
  const names = parseFailingTestNames([
    "TAP version 13",
    "not ok 1 - top-level property name",
    "  ---",
    "    error: failure",
    "  ...",
    "  not ok 2 - nested property name",
  ].join("\n"));
  assert.deepEqual(names, ["top-level property name", "nested property name"]);
});

test("the runner rejects an ambiguous source seam without mutating or leaving the synthetic harness dirty", async () => {
  const registry = [
    "export const mutations = [{",
    '  id: "ambiguous", property: "ambiguous source seam", file: "src/target.ts",',
    '  find: "good", replace: "bad", mustFail: ["synthetic target property"],',
    "}];",
    "",
  ].join("\n");
  const repo = await createSyntheticRepo(registry, undefined, 'export const value = "good";\n// good\n');

  const result = runSynthetic(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /FAIL ambiguous.*registry rot/);
  assert.match(result.output, /find occurred 2 times/);
  assert.equal(await readFile(repo.target, "utf8"), 'export const value = "good";\n// good\n');
  const status = spawnSync("git", ["status", "--porcelain", "--", "harness/"], {
    cwd: repo.root,
    encoding: "utf8",
  });
  assert.equal(status.stdout, "");
});

test("direct runner invocation through /var and /private/var aliases executes the main module", async () => {
  const registry = [
    "export const mutations = [{",
    '  id: "synthetic-target", property: "synthetic target property", file: "src/target.ts",',
    '  find: \'export const value = "good";\', replace: \'export const value = "bad";\',',
    '  mustFail: ["synthetic target property"],',
    "}];",
    "",
  ].join("\n");
  const repo = await createSyntheticRepo(registry);
  const scriptPath = join(repo.harness, "scripts", "mutation-check.ts");
  let aliasPath = "";
  if (scriptPath.startsWith("/private/var/")) {
    aliasPath = "/var" + scriptPath.slice("/private/var".length);
  } else if (scriptPath.startsWith("/var/")) {
    aliasPath = "/private/var" + scriptPath.slice("/var".length);
  } else {
    assert.fail("synthetic temp path is not under /var or /private/var");
  }
  assert.equal(await realpath(aliasPath), await realpath(scriptPath));

  for (const invocationPath of [scriptPath, aliasPath]) {
    const result = runSyntheticScript(repo, invocationPath);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /baseline: PASS/);
    assert.match(result.output, /summary: 1\/1 mutations passed/);
  }
});

test("the runner reuses the Node executable that launched it for every suite run", async () => {
  const registry = [
    "export const mutations = [{",
    '  id: "synthetic-target", property: "synthetic target property", file: "src/target.ts",',
    '  find: \'export const value = "good";\', replace: \'export const value = "bad";\',',
    '  mustFail: ["synthetic target property"],',
    "}];",
    "",
  ].join("\n");
  const testSource = [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { value } from "../src/target.ts";',
    "",
    'test("synthetic target property and current Node executable", () => {',
    '  assert.equal(value, "good");',
    `  assert.equal(process.execPath, ${JSON.stringify(NODE)});`,
    "});",
    "",
  ].join("\n");
  const repo = await createSyntheticRepo(registry, testSource);

  const result = runSynthetic(repo);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /baseline: PASS/);
  assert.match(result.output, /summary: 1\/1 mutations passed/);
});

test("the dirty-tree gate aborts before baseline tests or source mutation", async () => {
  const registry = [
    "export const mutations = [{",
    '  id: "synthetic-target", property: "synthetic target property", file: "src/target.ts",',
    '  find: \'export const value = "good";\', replace: \'export const value = "bad";\',',
    '  mustFail: ["synthetic target property"],',
    "}];",
    "",
  ].join("\n");
  const repo = await createSyntheticRepo(registry);
  await writeFile(join(repo.harness, "dirty-marker.txt"), "synthetic dirty state\n", "utf8");

  const result = runSynthetic(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /dirty-tree/);
  assert.doesNotMatch(result.output, /baseline: PASS|baseline: FAIL/);
  assert.equal(await readFile(repo.target, "utf8"), 'export const value = "good";\n');
});

test("a failing baseline aborts before applying the first mutation", async () => {
  const registry = [
    "export const mutations = [{",
    '  id: "synthetic-target", property: "synthetic target property", file: "src/target.ts",',
    '  find: \'export const value = "good";\', replace: \'export const value = "bad";\',',
    '  mustFail: ["synthetic target property"],',
    "}];",
    "",
  ].join("\n");
  const failingTest = [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { value } from "../src/target.ts";',
    "",
    'test("baseline is intentionally failing", () => {',
    '  assert.equal(value, "bad");',
    "});",
    "",
  ].join("\n");
  const repo = await createSyntheticRepo(registry, failingTest);

  const result = runSynthetic(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /baseline: FAIL/);
  assert.doesNotMatch(result.output, /PASS synthetic-target|UNPINNED PROPERTY/);
  assert.equal(await readFile(repo.target, "utf8"), 'export const value = "good";\n');
});

test("mutation results distinguish registry rot, an unpinned property, and the wrong test while restoring source", async () => {
  const registry = [
    "export const mutations = [",
    "  {",
    '    id: "registry-rot", property: "registry rot property", file: "src/target.ts",',
    '    find: "this source does not exist", replace: "bad", mustFail: ["synthetic target property"],',
    "  },",
    "  {",
    '    id: "unpinned", property: "unpinned property", file: "src/target.ts",',
    '    find: \'export const value = "good";\', replace: \'export const value = "good";\',',
    '    mustFail: ["synthetic target property"],',
    "  },",
    "  {",
    '    id: "wrong-test", property: "wrong test property", file: "src/target.ts",',
    '    find: \'export const value = "good";\', replace: \'export const value = "bad";\',',
    '    mustFail: ["a test name that cannot fail"],',
    "  },",
    "];",
    "",
  ].join("\n");
  const repo = await createSyntheticRepo(registry);

  const result = runSynthetic(repo);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /FAIL registry-rot — registry rot:/);
  assert.match(result.output, /UNPINNED PROPERTY/);
  assert.match(result.output, /FAIL wrong-test — wrong test:/);
  assert.equal(await readFile(repo.target, "utf8"), 'export const value = "good";\n');
  const status = spawnSync("git", ["status", "--porcelain", "--", "harness/"], {
    cwd: repo.root,
    encoding: "utf8",
  });
  assert.equal(status.stdout, "", "restoration must leave the synthetic harness clean");
});


test("the dirty-tree gate covers every directory the registry can mutate, not only harness/", async () => {
  // The standalone release manager under release/ is a mutable root. A gate
  // that still inspected only harness/ would let the runner mutate a release
  // file whose restoration it never verifies — losing the single guarantee
  // this tool provides.
  const registry = [
    "export const mutations = [{",
    '  id: "release-target", property: "synthetic release property", file: "../release/engram-release.ts",',
    '  find: \'export const releaseValue = "good";\', replace: \'export const releaseValue = "bad";\',',
    '  mustFail: ["synthetic release property remains true"]',
    "}];",
    "",
  ].join("\n");
  const repo = await createSyntheticRepo(registry);
  const release = join(repo.root, "release");
  await writeFile(join(release, "engram-release.ts"), 'export const releaseValue = "good";\n', "utf8");
  git(repo.root, ["add", "."]);
  git(repo.root, ["commit", "-m", "synthetic release fixture"]);

  await writeFile(join(release, "dirty-marker.txt"), "synthetic dirty state\n", "utf8");

  const result = runSynthetic(repo);

  assert.notEqual(result.status, 0);
  assert.match(result.output, /dirty-tree/);
  assert.doesNotMatch(result.output, /baseline: PASS|baseline: FAIL/);
  assert.equal(await readFile(join(release, "engram-release.ts"), "utf8"), 'export const releaseValue = "good";\n');
});

test("property: a mutable-root symlink cannot redirect a mutation outside its physical boundary", async () => {
  const registry = [
    "export const mutations = [{",
    '  id: "symlink-escape", property: "symlink escape property", file: "src/escape.ts",',
    '  find: \'export const escaped = "good";\', replace: \'export const escaped = "bad";\',',
    '  mustFail: ["synthetic target property remains true"]',
    "}];",
    "",
  ].join("\n");
  const repo = await createSyntheticRepo(registry);
  const outside = join(repo.root, "outside.ts");
  const escape = join(repo.harness, "src", "escape.ts");
  await writeFile(outside, 'export const escaped = "good";\n', "utf8");
  await symlink(outside, escape);
  git(repo.root, ["add", "."]);
  git(repo.root, ["commit", "-m", "synthetic symlink escape fixture"]);

  const result = runSynthetic(repo);

  assert.notEqual(result.status, 0);
  assert.match(result.output, /outside the mutable roots/);
  assert.match(result.output, /baseline: PASS/);
  assert.doesNotMatch(result.output, /UNPINNED PROPERTY/);
  assert.equal(await readFile(outside, "utf8"), 'export const escaped = "good";\n');
});

test("a mutation naming a file outside every mutable root is still refused", async () => {
  const registry = [
    "export const mutations = [{",
    '  id: "escaping-target", property: "escaping property", file: "../outside/target.ts",',
    '  find: \'good\', replace: \'bad\',',
    '  mustFail: ["synthetic target property remains true"]',
    "}];",
    "",
  ].join("\n");
  const repo = await createSyntheticRepo(registry);
  const outside = join(repo.root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "target.ts"), "good\n", "utf8");
  git(repo.root, ["add", "."]);
  git(repo.root, ["commit", "-m", "synthetic outside fixture"]);
  const result = runSynthetic(repo);

  assert.notEqual(result.status, 0);
  // Asserting the refusal itself, not merely a nonzero exit: without the
  // containment guard the runner still exits nonzero, because it mutates the
  // escaping file, finds the property unpinned, and restores it. Only the
  // refusal message distinguishes "never touched it" from "touched it and
  // put it back".
  assert.match(result.output, /outside the mutable roots/);
  assert.equal(await readFile(join(outside, "target.ts"), "utf8"), "good\n");
});