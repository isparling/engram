import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Public-source-surface check.
 *
 * This test walks the roots that would ever be published as the target's
 * public source tree and asserts that no historical, cross-domain, private,
 * bundle-path, or direction marker survives in a path name or in file text.
 * The observable contract is `assert.deepEqual(hits, [])`.
 *
 * Forbidden patterns are assembled from fragments (and character classes are
 * used in place of literal letters) so that this file does not match its own
 * source. See the fragment definitions below.
 */
const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SELF_PATH), "..", "..");


/** Generated/foreign subtrees that are not source and are never scanned. */
const excludedDirNames: Record<string, true> = { "node_modules": true, ".git": true, ".superpowers": true };
/** Generated CLI payload dirs (produced by the prepack script, not source). */
const excludedGeneratedPrefixes = [
  join("harness", "cli", "src"),
  join("harness", "cli", "release"),
];
const excludedArchiveSuffix = ".tgz";

/** Enumerates every top-level public source entry rather than a stale allowlist. */
function publicRoots(root: string): string[] {
  return readdirSync(root).filter((entry) => excludedDirNames[entry] !== true);
}
/** A probe matched against both a relative path name and each file's text. */
type Probe = { label: string; test: (text: string) => boolean };

// ---------------------------------------------------------------------------
// Forbidden patterns, assembled from fragments so this file never contains a
// whole forbidden token and therefore never matches itself.
// ---------------------------------------------------------------------------

const numberedPhaseLabel = new RegExp(["\\b", "[Mm]", "ilestone", "\\b"].join(""));
const uppercasePhaseLabel = new RegExp(["\\b", "M", "[1-5]", "(?:\\b|_)"].join(""));
const lowercasePhaseId = new RegExp(["\\b", "m", "[3-5]", "-"].join(""));

const probes: Probe[] = [
  {
    // Prior product / consumer names.
    label: "prior consumer name",
    test: (t) => t.includes("claw" + "-" + "co" + "ach") || t.includes("pei" + "gs"),
  },
  {
    // Absolute user home paths, except synthetic fixtures and documented
    // placeholders. Covers macOS, Linux, and Windows path forms.
    label: "absolute user path",
    test: (t) =>
      new RegExp(
        "(?:/" + "Users/|/" + "home/|[A-Za-z]:\\\\{1,2}Users\\\\{1,2})" +
          "(?!" + "ex" + "ample\\b|" + "<user>\\b)" + "[A-Za-z0-9_.-]+",
      ).test(t),
  },
  {
    // Orchestration roots.
    label: "orchestration root",
    test: (t) =>
      t.includes("." + "superpowers/") ||
      t.includes("." + "worktrees/") ||
      t.includes("no" + "tes/") ||
      t.includes("exper" + "iments/"),
  },
  {
    // Pack-module paths: a shipped tree, the scoped shorthand, or the former
    // named package.
    label: "bundled pack path",
    test: (t) =>
      t.includes("pac" + "ks/") ||
      t.includes("@" + "engram/" + "pac" + "ks") ||
      t.includes("train" + "ing" + "-" + "lessons"),
  },
  {
    // Domain words, even inside comments or fixture text.
    label: "domain term",
    test: (t) =>
      /\b[aA]thlete\b/.test(t) ||
      /\b[cC]oach\b/.test(t) ||
      /\b[cC]oaching\b/.test(t) ||
      /\b[cC]linician\b/.test(t) ||
      /\b[cC]linical\b/.test(t) ||
      /\b[tT]raining\b/.test(t),
  },
  {
    // Decision identifiers of the form D-<number>.
    label: "decision identifier",
    test: (t) => /\bD-[0-9]+/.test(t),
  },
  {
    // Numbered phase labels, including identifier-bound forms and lowercase
    // prefixed ids.
    label: "numbered phase label",
    test: (t) => numberedPhaseLabel.test(t) || uppercasePhaseLabel.test(t) || lowercasePhaseId.test(t),
  },
  {
    // Direction language.
    label: "direction language",
    test: (t) =>
      t.includes("PROVI" + "SIONAL") ||
      /\b[sS]pike\b/.test(t) ||
      /\b[hH]ypothesi/.test(t) ||
      /\b[rR]oadmap\b/.test(t) ||
      /\b[aA]mended\b/.test(t) ||
      // "superseded-by" is the knowledge-model history event identifier and is
      // a genuine data term, so a trailing hyphen excludes exactly that form.
      /\b[sS]uperseded\b(?!-)/.test(t),
  },
];

/** Returns paths of every file under `root` that is part of the public surface. */
function collectFiles(root: string): string[] {
  const files: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.pop();
    if (dir === undefined) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (excludedDirNames[entry] === true) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        queue.push(full);
        continue;
      }
      const rel = normalize(relative(REPO_ROOT, full));
      if (excludedGeneratedPrefixes.some((prefix) => rel === prefix || rel.startsWith(prefix + sep))) continue;
      if (rel.endsWith(excludedArchiveSuffix)) continue;
      files.push(rel);
    }
  }
  return files;
}

test("property: public-source probes reject every forbidden identity and home-path form", () => {
  const cases = [
    ["prior consumer name", "pei" + "gs"],
    ["absolute user path", "/" + "home/" + "private-user"],
    ["absolute user path", "C:" + "\\" + "Users" + "\\" + "private-user"],
  ] as const;
  for (const [label, sample] of cases) {
    assert.equal(probes.some((probe) => probe.label === label && probe.test(sample)), true, sample);
  }
});

test("source-boundary probes do not match their own definitions", () => {
  const source = readFileSync(SELF_PATH, "utf8");
  const matchingLabels = probes.filter((probe) => probe.test(source)).map((probe) => probe.label);
  assert.deepEqual(matchingLabels, []);
});

test("property: the public source root does not ignore an orchestration worktree", () => {
  const ignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
  assert.equal(ignore.split(/\r?\n/).some((line) => line === "." + "worktrees/"), false);
});

test("no historical, cross-domain, private, bundle-path, or direction marker survives in the public source surface", () => {
  const hits: string[] = [];

  for (const root of publicRoots(REPO_ROOT)) {
    const absolute = join(REPO_ROOT, root);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue; // root not present (e.g. LICENSE before it is added) is not a violation
    }
    const files = stat.isDirectory() ? collectFiles(absolute) : [normalize(relative(REPO_ROOT, absolute))];

    for (const rel of files) {
      if (resolve(REPO_ROOT, rel) === SELF_PATH) continue; // this file never tests itself
      const full = resolve(REPO_ROOT, rel);

      for (const probe of probes) {
        if (probe.test(rel)) hits.push(`${rel} [path: ${probe.label}]`);
      }

      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue; // unreadable/binary file is out of scope
      }
      if (text.includes("\u0000")) continue; // binary

      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line === undefined) continue;
        for (const probe of probes) {
          if (probe.test(line)) hits.push(`${rel}:${index + 1} [${probe.label}]`);
        }
      }
    }
  }

  assert.deepEqual(hits, []);
});

test("property: the public-content guard detects forbidden text under a newly added top-level root", async () => {
  if (process.env.ENGRAM_PUBLIC_GUARD_CHILD === "1") return;

  const fixtureRoot = await mkdtemp(join(tmpdir(), "engram-public-source-guard-"));
  const fixtureTest = join(fixtureRoot, "harness", "test", "publicSourceContent.test.ts");
  try {
    await mkdir(dirname(fixtureTest), { recursive: true });
    await cp(SELF_PATH, fixtureTest);
    await writeFile(join(fixtureRoot, ".gitignore"), "\n", "utf8");
    await writeFile(join(fixtureRoot, "unlisted-top-level.txt"), "claw" + "-" + "co" + "ach\n", "utf8");

    const env: Record<string, string | undefined> = { ...process.env, ENGRAM_PUBLIC_GUARD_CHILD: "1" };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", "--experimental-strip-types", fixtureTest], {
      encoding: "utf8",
      env,
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("property: public docs and package metadata state the pack-free artifact boundary", () => {
  if (process.env.ENGRAM_PUBLIC_GUARD_CHILD === "1") return;
  const architecture = readFileSync(join(REPO_ROOT, "ARCHITECTURE.md"), "utf8");
  const cliSource = readFileSync(join(REPO_ROOT, "harness", "src", "cli.ts"), "utf8");
  const resolutionDoc = readFileSync(join(REPO_ROOT, "harness", "docs", "architecture", "external-pack-resolution.md"), "utf8");
  const harnessReadme = readFileSync(join(REPO_ROOT, "harness", "README.md"), "utf8");
  const cliReadme = readFileSync(join(REPO_ROOT, "harness", "cli", "README.md"), "utf8");
  const cliPackage: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "harness", "cli", "package.json"), "utf8"));
  const hits: string[] = [];

  if (!architecture.includes("It contains no pack module")) hits.push("ARCHITECTURE.md does not exclude pack modules");
  if (architecture.includes("explicitly included reusable packs")) hits.push("ARCHITECTURE.md says releases include packs");
  if (!cliSource.includes("harness/docs/pack-interface.md")) hits.push("cli.ts does not cite the published pack interface");
  if (cliSource.includes("PACK_INTERFACE.md")) hits.push("cli.ts cites the removed pack interface");
  if (!resolutionDoc.includes("findExport")) hits.push("external-pack-resolution.md names the wrong loader helper");
  if (!resolutionDoc.includes("pack_identity_mismatch")) hits.push("external-pack-resolution.md does not describe the identity refusal");
  if (resolutionDoc.includes("from-fallback")) hits.push("external-pack-resolution.md implies a fallback");
  const interfaceUrl = "https://github.com/isparling/engram/blob/main/harness/docs/pack-interface.md";
  if (!harnessReadme.includes(interfaceUrl)) hits.push("harness README has no public pack-interface link");
  if (!cliReadme.includes(interfaceUrl)) hits.push("CLI README has no public pack-interface link");
  if (
    typeof cliPackage !== "object" ||
    cliPackage === null ||
    !("publishConfig" in cliPackage) ||
    typeof cliPackage.publishConfig !== "object" ||
    cliPackage.publishConfig === null ||
    !("access" in cliPackage.publishConfig) ||
    cliPackage.publishConfig.access !== "public"
  ) {
    hits.push("CLI package is not configured for public scoped publish");
  }
  assert.deepEqual(hits, []);
});