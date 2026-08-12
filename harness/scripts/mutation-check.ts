import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { mutations, type Mutation } from "../mutations.ts";

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
};

export type SuiteResult = {
  exitCode: number | null;
  failingTestNames: string[];
  /** Every test name Node's TAP reporter recorded a result for, passing or
   * failing. Used to tell "this mustFail name never matched a running test"
   * (a registry authoring error) apart from "it matched and simply passed"
   * (a genuinely unpinned property) when the run is scoped by
   * --test-name-pattern and most of the suite never executes at all. */
  allTestNames: string[];
};

export type MutationSelection = {
  mutations: Mutation[];
  unknownIds: string[];
};

type MutationResult = {
  passed: boolean;
  line: string;
};

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function runCommand(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    stdout: textFrom(result.stdout),
    stderr: textFrom(result.stderr),
    error: result.error,
  };
}

function runGit(repoRoot: string, args: string[]): string {
  const result = runCommand("git", args, repoRoot);
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("git command failed");
  }
  return result.stdout;
}

function findRepositoryRoot(): string {
  const output = runGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  if (output.length === 0) throw new Error("git did not return a repository root");
  return realpathSync(output);
}

function harnessRoot(repoRoot: string): string {
  return join(repoRoot, "harness");
}

/**
 * The directories a mutation is allowed to touch, relative to the repository
 * root. Two guards depend on this list and MUST stay in agreement: mutation
 * files are refused outside it, and the dirty-tree/restoration checks inspect
 * exactly it. If they diverged, the runner could mutate a file whose
 * restoration it never verifies — which is the one guarantee this tool exists
 * to provide.
 *
 * The core source tree and the standalone release manager are the only
 * mutable surfaces. Packs are external modules resolved through a binding's
 * `installed_packs[].from` specifier and are never mutated by this tool.
 * `release/` is included because the standalone manager owns release-metadata
 * properties pinned here.
 */
const MUTABLE_ROOTS = ["harness", "release"] as const;

function isCanonicalDescendant(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation.length === 0 || (!relation.startsWith(".." + sep) && relation !== ".." && !isAbsolute(relation));
}

function canonicalMutableRootPaths(repoRoot: string): string[] {
  const canonicalRepoRoot = realpathSync(repoRoot);
  return MUTABLE_ROOTS.map((root) => {
    const canonicalRoot = realpathSync(join(canonicalRepoRoot, root));
    if (!isCanonicalDescendant(canonicalRepoRoot, canonicalRoot)) {
      throw new Error("mutable root is outside repository");
    }
    return canonicalRoot;
  });
}

function mutationFilePath(repoRoot: string, file: string): string {
  // Registry paths stay relative to harness/, so a release entry reads
  // "../release/engram-release.ts".
  const candidate = realpathSync(resolve(harnessRoot(repoRoot), file));
  if (!canonicalMutableRootPaths(repoRoot).some((root) => isCanonicalDescendant(root, candidate))) {
    throw new Error(`mutation file is outside the mutable roots (${MUTABLE_ROOTS.join(", ")})`);
  }
  return candidate;
}

function mutationRepoPath(repoRoot: string, filePath: string): string {
  if (!isCanonicalDescendant(repoRoot, filePath) || filePath === repoRoot) {
    throw new Error("mutation file is outside repository");
  }
  return relative(repoRoot, filePath);
}

function statusUnderMutableRoots(repoRoot: string): string {
  const roots = canonicalMutableRootPaths(repoRoot).map((root) => relative(repoRoot, root) + "/");
  return runGit(repoRoot, ["status", "--porcelain", "--", ...roots]);
}

function printLine(line: string): void {
  process.stdout.write(line + "\n");
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** Extracts names from Node's TAP reporter, including nested/indented tests. */
export function parseFailingTestNames(output: string): string[] {
  const names: string[] = [];
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    // Bun format: "(fail) test name [duration]"
    const bunMatch = /^\(fail\)\s+(.*?)\s+\[\d/.exec(line);
    if (bunMatch) {
      const name = bunMatch[1];
      if (name !== undefined) names.push(name);
      continue;
    }
    // Node TAP
    const match = /^\s*(?:#\s*)?not ok(?:\s+\d+)?\s*-\s*(.*?)\s*$/.exec(line);
    const name = match?.[1];
    if (name !== undefined && name.length > 0) names.push(name);
  }
  return names;
}

/** Extracts every reported test name, passing or failing, from Node's TAP
 * reporter, including nested/indented tests. Note that when a run is scoped
 * with --test-name-pattern, a test file with no internally matching test
 * still reports itself as a single trivially-passing entry (its own
 * filename) — this list is not filtered for that, callers that care about
 * genuine test names should account for it. */
export function parseAllTestNames(output: string): string[] {
  const names: string[] = [];
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    // Bun format: "(pass) test name [duration]" or "(fail) test name [duration]"
    const bunMatch = /^\((?:pass|fail)\)\s+(.*?)\s+\[\d/.exec(line);
    if (bunMatch) {
      const name = bunMatch[1];
      if (name !== undefined) names.push(name);
      continue;
    }
    // Node TAP
    const match = /^\s*(?:#\s*)?(?:not )?ok(?:\s+\d+)?\s*-\s*(.*?)\s*$/.exec(line);
    const name = match?.[1];
    if (name !== undefined && name.length > 0) names.push(name);
  }
  return names;
}

export function countOccurrences(text: string, needle: string): number {
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

/** Keeps requested entries in registry order; arguments never reorder the registry. */
export function selectMutations(requestedIds: string[], registry: readonly Mutation[] = mutations): MutationSelection {
  const knownIds = new Set(registry.map((mutation) => mutation.id));
  const unknownIds: string[] = [];
  const reportedUnknown = new Set<string>();
  for (const id of requestedIds) {
    if (!knownIds.has(id) && !reportedUnknown.has(id)) {
      unknownIds.push(id);
      reportedUnknown.add(id);
    }
  }

  if (requestedIds.length === 0) {
    return { mutations: [...registry], unknownIds };
  }

  const requested = new Set(requestedIds);
  return {
    mutations: registry.filter((mutation) => requested.has(mutation.id)),
    unknownIds,
  };
}

/** Escapes regex metacharacters so a literal substring can be embedded in a
 * --test-name-pattern regex without changing its matching semantics. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds a single alternation regex matching any of the given literal
 * test-name substrings, for use with Node's --test-name-pattern. */
export function buildTestNamePattern(names: readonly string[]): string {
  return names.map(escapeRegExp).join("|");
}

function runTestSuite(harnessDir: string, testNamePattern?: string): SuiteResult {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.NODE_TEST_CONTEXT;
  const args =
    testNamePattern === undefined
      ? ["--test"]
      : ["--test", "--test-name-pattern=" + testNamePattern];
  const result = spawnSync(process.execPath, args, { cwd: harnessDir, encoding: "utf8", env });
  const output = result.stdout + "\n" + result.stderr;
  return {
    exitCode: result.error === undefined ? result.status : 1,
    failingTestNames: parseFailingTestNames(output),
    allTestNames: parseAllTestNames(output),
  };
}

function runBunTestSuite(harnessDir: string, testNamePattern?: string): SuiteResult {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const args =
    testNamePattern === undefined
      ? ["test", "./ompExtension.check.ts"]
      : ["test", "./ompExtension.check.ts", "--test-name-pattern=" + testNamePattern];
  const result = spawnSync("bun", args, { cwd: harnessDir, encoding: "utf8", env });
  const output = result.stdout + "\n" + result.stderr;
  return {
    exitCode: result.error === undefined ? result.status : 1,
    failingTestNames: parseFailingTestNames(output),
    allTestNames: parseAllTestNames(output),
  };
}

function registryShapeErrors(registry: readonly Mutation[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const mutation of registry) {
    if (seen.has(mutation.id)) errors.push("duplicate mutation id " + mutation.id);
    seen.add(mutation.id);
    if (mutation.id.length === 0) errors.push("mutation id is empty");
    if (mutation.file.length === 0) errors.push(mutation.id + " has no file");
    if (mutation.find.length === 0) errors.push(mutation.id + " has an empty find string");
    if (mutation.replace.length === 0) errors.push(mutation.id + " has an empty replacement");
    if (mutation.mustFail.length === 0) errors.push(mutation.id + " has no mustFail test names");
  }
  return errors;
}

function formatNames(names: string[]): string {
  return names.length === 0 ? "none parsed" : names.join(" | ");
}

async function runOneMutation(mutation: Mutation, repoRoot: string): Promise<MutationResult> {
  let filePath: string;
  try {
    filePath = mutationFilePath(repoRoot, mutation.file);
  } catch (error) {
    // Report what the guard actually said. A hardcoded message here silently
    // drifts from the guard it describes.
    return {
      passed: false,
      line: "FAIL " + mutation.id + " — registry rot: " + (error instanceof Error ? error.message : String(error)),
    };
  }

  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    return {
      passed: false,
      line: "FAIL " + mutation.id + " — registry rot: mutation file could not be read",
    };
  }

  const occurrences = countOccurrences(source, mutation.find);
  if (occurrences !== 1) {
    return {
      passed: false,
      line:
        "FAIL " +
        mutation.id +
        " — registry rot: find occurred " +
        occurrences +
        " times (expected exactly once)",
    };
  }

  const repoPath = mutationRepoPath(repoRoot, filePath);
  let suite: SuiteResult | undefined;
  let operationFailed = false;
  let restorationFailed = false;

  try {
    await writeFile(filePath, source.replace(mutation.find, mutation.replace), "utf8");
    const pattern = buildTestNamePattern(mutation.mustFail);
    suite = mutation.id === "omp-extension-registers-engram-capture-tool"
      ? runBunTestSuite(harnessRoot(repoRoot), pattern)
      : runTestSuite(harnessRoot(repoRoot), pattern);
  } catch {
    operationFailed = true;
  } finally {
    try {
      execFileSync("git", ["checkout", "--", repoPath], { cwd: repoRoot, stdio: "ignore" });
    } catch {
      restorationFailed = true;
    }
  }

  if (restorationFailed) {
    return {
      passed: false,
      line:
        "FAIL " +
        mutation.id +
        " — restoration failure: git checkout -- " +
        repoPath +
        " did not complete",
    };
  }
  if (operationFailed || suite === undefined) {
    return {
      passed: false,
      line: "FAIL " + mutation.id + " — mutation error: could not apply or run the full suite",
    };
  }

  if (suite.exitCode === 0) {
    // A scoped run with a --test-name-pattern that matches nothing still
    // exits 0 (each unmatched test file reports itself as a single trivially
    // -passing entry). That is registry rot, not an unpinned property: tell
    // them apart by checking whether every mustFail name actually matched a
    // test that ran, not just that the (possibly empty) run stayed green.
    const neverRan = mutation.mustFail.filter(
      (expected) => !suite.allTestNames.some((name) => name.includes(expected)),
    );
    if (neverRan.length > 0) {
      return {
        passed: false,
        line:
          "FAIL " +
          mutation.id +
          " — wrong test: mustFail substring(s) never matched a test that ran: " +
          neverRan.join(" | ") +
          "; observed: " +
          formatNames(suite.allTestNames),
      };
    }
    return {
      passed: false,
      line: "!!! UNPINNED PROPERTY !!! " + mutation.id + " — suite stayed green",
    };
  }

  const missing = mutation.mustFail.filter(
    (expected) => !suite.failingTestNames.some((name) => name.includes(expected)),
  );
  if (missing.length > 0) {
    return {
      passed: false,
      line:
        "FAIL " +
        mutation.id +
        " — wrong test: suite failed, but mustFail substring(s) did not match a failing test name: " +
        missing.join(" | ") +
        "; observed: " +
        formatNames(suite.failingTestNames),
    };
  }

  return {
    passed: true,
    line: "PASS " + mutation.id + " — " + mutation.property,
  };
}

export async function runMutationCheck(requestedIds: string[] = process.argv.slice(2)): Promise<number> {
  const mutationIds: string[] = [];
  let expectsId = false;
  for (const requestedId of requestedIds) {
    if (requestedId === "--id") {
      expectsId = true;
      continue;
    }
    mutationIds.push(requestedId);
    expectsId = false;
  }
  if (expectsId) {
    printLine("ABORT missing mutation id");
    return 1;
  }
  let repoRoot: string;
  try {
    repoRoot = findRepositoryRoot();
  } catch {
    printLine("ABORT mutation-check: unable to determine the git repository root");
    return 1;
  }

  let initialStatus: string;
  try {
    initialStatus = statusUnderMutableRoots(repoRoot);
  } catch {
    printLine(`ABORT mutation-check: unable to inspect git status for ${MUTABLE_ROOTS.join("/, ")}/`);
    return 1;
  }
  if (initialStatus.trim().length > 0) {
    printLine(
      `ABORT dirty-tree: git status --porcelain -- ${MUTABLE_ROOTS.map((root) => root + "/").join(" ")} is not empty; commit or stash those changes before running mutations`,
    );
    return 1;
  }

  const shapeErrors = registryShapeErrors(mutations);
  if (shapeErrors.length > 0) {
    for (const error of shapeErrors) printLine("FAIL registry: " + error);
    return 1;
  }

  const selection = selectMutations(mutationIds);
  if (selection.unknownIds.length > 0) {
    printLine("ABORT unknown mutation id: " + selection.unknownIds.join(", "));
    return 1;
  }

  const baseline = runTestSuite(harnessRoot(repoRoot));
  if (baseline.exitCode !== 0) {
    printLine("ABORT baseline: FAIL — refusing to apply any mutation");
    printLine("baseline failing test names: " + formatNames(baseline.failingTestNames));
    return 1;
  }
  printLine("baseline: PASS");

  let passed = 0;
  for (const mutation of selection.mutations) {
    const result = await runOneMutation(mutation, repoRoot);
    printLine(result.line);
    if (result.passed) passed++;
  }

  let finalStatus = "";
  try {
    finalStatus = statusUnderMutableRoots(repoRoot);
  } catch {
    printLine(`!!! RESTORATION FAILURE: unable to verify git status for ${MUTABLE_ROOTS.join("/, ")}/`);
    return 1;
  }
  const restorationClean = finalStatus.trim().length === 0;
  if (!restorationClean) {
    printLine(
      `!!! RESTORATION FAILURE !!! git status --porcelain -- ${MUTABLE_ROOTS.map((root) => root + "/").join(" ")} is not empty after the mutation loop`,
    );
  }

  const expectationFailures = selection.mutations.length - passed;
  printLine(
    "summary: " +
      passed +
      "/" +
      selection.mutations.length +
      " mutations passed; " +
      expectationFailures +
      " expectation failure(s)",
  );
  return expectationFailures === 0 && restorationClean ? 0 : 1;
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(invokedPath) === realpathSync(modulePath);
  } catch {
    return resolve(invokedPath) === resolve(modulePath);
  }
}

if (isMainModule()) {
  runMutationCheck().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      printLine("ABORT mutation-check: unexpected runner failure");
      process.exitCode = 1;
    },
  );
}
