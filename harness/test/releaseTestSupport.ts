import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  defaultQualificationRunner,
  qualifyAndPublishR0,
  type QualificationOutput,
  type QualificationResult,
  type QualificationRunner,
} from "../scripts/release.ts";

const execFile = promisify(execFileCallback);

export type SyntheticReleaseSource = {
  root: string;
  stage: string;
  output: string;
  revision: string;
  expectedAllowedPaths: readonly string[];
};

async function writeSourceFile(root: string, path: string, content: string, executable = false): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
  if (executable) await chmod(destination, 0o755);
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFile("git", [...args], { cwd: root });
  return result.stdout;
}

export async function createSyntheticReleaseSource(): Promise<SyntheticReleaseSource> {
  const root = await mkdtemp(join(tmpdir(), "engram-release-source-"));
  const stage = join(root, "stage");
  const output = join(root, "output");
  const sourceFiles: readonly [string, string, boolean?][] = [
    ["harness/src/linked/escaped.ts", "export const linked = 'fictional-linked';\n"],
    ["bin/engram", "#!/bin/sh\necho fictional-launcher\n", true],
    ["harness/src/cli.ts", "console.log('fictional cli');\n"],
    ["harness/src/runtime.ts", "export const runtime = 'fictional-runtime';\n"],
    ["release/engram-release.ts", "export const fixtureManager = 'fictional-manager';\n"],
    ["machine-binding.json", "FICTIONAL-TRACKED-BINDING-SENTINEL\n"],
    ["qmd-cache/index.bin", "FICTIONAL-QMD-CACHE-SENTINEL\n"],
    ["receipts/publication.txt", "FICTIONAL-RECEIPT-SENTINEL\n"],
    ["retained-presentations/brief.txt", "FICTIONAL-PRESENTATION-SENTINEL\n"],
  ];
  for (const [path, content, executable] of sourceFiles) await writeSourceFile(root, path, content, executable);

  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "Synthetic Fixture"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "synthetic release source"]);
  const revision = (await git(root, ["rev-parse", "HEAD"])).trim();

  return {
    root,
    stage,
    output,
    revision,
    expectedAllowedPaths: [
      "bin/engram",
      "harness/package.json",
      "harness/src/cli.ts",
      "harness/src/linked/escaped.ts",
      "harness/src/runtime.ts",
      "release-manifest.json",
      "release/engram-release.ts",
    ],
  };
}

export async function replaceSyntheticReleaseFile(
  source: SyntheticReleaseSource,
  path: string,
  content: string,
  executable = false,
): Promise<void> {
  await writeSourceFile(source.root, path, content, executable);
  await git(source.root, ["add", path]);
  await git(source.root, ["commit", "--quiet", "-m", `replace synthetic ${path}`]);
  source.revision = (await git(source.root, ["rev-parse", "HEAD"])).trim();
}

export async function createSyntheticReleaseSourceWithTrackedLeafSymlink(): Promise<SyntheticReleaseSource> {
  const source = await createSyntheticReleaseSource();
  await symlink("../../.git/config", join(source.root, "harness", "src", "leak.ts"));
  await git(source.root, ["add", "harness/src/leak.ts"]);
  await git(source.root, ["commit", "--quiet", "-m", "tracked leaf symlink"]);
  return { ...source, revision: (await git(source.root, ["rev-parse", "HEAD"])).trim() };
}

export async function destroySyntheticReleaseSource(source: SyntheticReleaseSource): Promise<void> {
  const makeWritable = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      await chmod(path, 0o755);
      for (const entry of await readdir(path)) await makeWritable(join(path, entry));
    } else {
      await chmod(path, 0o644);
    }
  };
  await makeWritable(source.root);
  await rm(source.root, { recursive: true, force: true });
}

export function createStubbedGateRunner(): QualificationRunner {
  return async (command, args, options) => {
    if (command === "npm") return { code: 0, stdout: "", stderr: "" };
    if (command === "qmd" && args[0] === "status") {
      const configDir = options.env.QMD_CONFIG_DIR;
      const cacheHome = options.env.XDG_CACHE_HOME;
      if (typeof configDir !== "string" || typeof cacheHome !== "string") {
        return { code: 1, stdout: "", stderr: "missing scoped qmd environment\n" };
      }
      // Read back the collection name release.ts actually wrote to the
      // scoped config, rather than duplicating that literal here, so this
      // stub tracks whatever synthetic binding the real code creates.
      const configText = await readFile(join(configDir, "index.yml"), "utf8");
      const collectionName = configText.match(/^collections:\n {2}([^:\n]+):/)?.[1] ?? "unknown-collection";
      const indexPath = join(cacheHome, "qmd", "index.sqlite");
      const stdout = [
        "QMD Status",
        "",
        `Index: ${indexPath}`,
        "Size:  4.0 KB",
        "",
        "Documents",
        "  Total:    0 files indexed",
        "  Vectors:  0 embedded",
        "",
        "Collections",
        `  ${collectionName} (qmd://${collectionName}/)`,
        "    Pattern:  *.md",
        "    Files:    0 (updated never)",
        "",
      ].join("\n");
      return { code: 0, stdout, stderr: "" };
    }
    if (command === "qmd") return { code: 1, stdout: "", stderr: "unexpected synthetic qmd invocation\n" };
    return defaultQualificationRunner(command, args, options);
  };
}

const qualificationSources: SyntheticReleaseSource[] = [];
const qualificationScratchRoots: string[] = [];

/** Drains and cleans up every scratch resource `qualifySyntheticRelease`
 * has created so far: synthetic source repos and qualification/output
 * temp roots. Call from a test file's own `after()` alongside its own
 * `sources` cleanup. */
export async function destroyQualificationScratch(): Promise<void> {
  await Promise.all([
    ...qualificationSources.splice(0).map((source) => destroySyntheticReleaseSource(source)),
    ...qualificationScratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => {})),
  ]);
}

// The packaged `bin/engram` stand-in for qualification tests. `space status`
// must emit the EXACT projection the real CLI emits (inspectSpaceRegistry /
// statusFor in harness/src/spaceRegistry.ts): a 13-key ActiveSpaceStatus per
// active host session, not a fixture-shaped shortcut. The projection is built
// from the same registry + binding + space-manifest files release.ts wrote
// for the synthetic space (the registry entry's binding_path points at the
// binding, whose manifest_path points at the space manifest), mirroring what
// the real cli.ts reads. The ambient-sentinel refusal below is load-bearing:
// it proves scoped smoke commands cannot inherit the caller's environment.
const RUNNABLE_QUALIFICATION_ENGRAM = `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const here = dirname(new URL(import.meta.url).pathname);
const manifest = JSON.parse(await readFile(join(here, '..', 'release-manifest.json'), 'utf8'));
const [command, subcommand] = process.argv.slice(2);
if (command === 'space' && subcommand === 'status') {
  if (process.env.ENGRAM_QUALIFICATION_AMBIENT_SENTINEL !== undefined) {
    console.error('ambient variable reached packaged smoke');
    process.exit(1);
  }
  const registryPath = process.env.ENGRAM_BINDING_REGISTRY;
  const sessionId = process.env.ENGRAM_HOST_SESSION_ID;
  if (!registryPath || !sessionId) {
    console.error('missing synthetic space binding');
    process.exit(1);
  }
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const registered = registry.spaces.map((entry) => entry.space_id);
  const activeId = registry.active[sessionId];
  if (registered.length !== 1 || activeId !== registered[0]) {
    console.error('synthetic space is not exclusively registered and selected');
    process.exit(1);
  }
  const entry = registry.spaces[0];
  const binding = JSON.parse(await readFile(entry.binding_path, 'utf8'));
  const spaceManifest = JSON.parse(await readFile(binding.manifest_path, 'utf8'));
  console.log(JSON.stringify({
    schema_version: 0,
    registered_spaces: registered,
    active_spaces: {
      [sessionId]: {
        space_id: activeId,
        space_root: entry.boundary.space_root,
        records_root: entry.boundary.records_root,
        qmd: {
          collection: binding.qmd_collection_name,
          config_dir: binding.qmd_config_dir,
          cache_home: binding.qmd_cache_home,
        },
        sessions_dir: binding.sessions_dir,
        read_roots: binding.read_roots,
        write_roots: binding.write_roots,
        allowed_models: binding.provider_policy.allowed_models,
        knowledge_schema_version: spaceManifest.knowledge_schema_version,
        packs: binding.installed_packs,
        compatibility: 'compatible',
        qmd_freshness: (registry.state && registry.state[activeId] && registry.state[activeId].qmd_freshness) || 'unknown',
        session_boundary: 'validated-not-enforced',
      },
    },
    last_boundary_error: registry.last_boundary_error ?? null,
  }));
  process.exit(0);
}
console.log(JSON.stringify({ release_id: manifest.version }));
`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type SyntheticSpaceStatusFixture = {
  /** The full `SpaceRegistryStatus` projection the packaged CLI emits. */
  status: Record<string, unknown>;
  /** Direct reference to `active_spaces[hostSessionId]`, mutable for defect tests. */
  active: Record<string, unknown>;
};

/**
 * Builds the exact `engram space status` projection the real CLI emits
 * (`inspectSpaceRegistry`/`statusFor` in harness/src/spaceRegistry.ts) from
 * the registry + binding + space-manifest files release.ts wrote for the
 * synthetic qualification space. This mapping must stay identical to the
 * one embedded in `RUNNABLE_QUALIFICATION_ENGRAM` (and to the real product):
 * one side is the standalone packaged stand-in, the other the test-side
 * builder that defect tests mutate.
 */
export async function buildRealSpaceStatusFixture(registryPath: string, hostSessionId: string): Promise<SyntheticSpaceStatusFixture> {
  const registry: unknown = JSON.parse(await readFile(registryPath, "utf8"));
  if (!isObject(registry)) throw new Error(`synthetic space registry is not an object: ${registryPath}`);
  const { active, spaces, state } = registry;
  if (!isObject(active) || !Array.isArray(spaces) || spaces.length !== 1) {
    throw new Error("synthetic space is not exclusively registered and selected");
  }
  const registered = spaces.map((entry) => (isObject(entry) && typeof entry.space_id === "string" ? entry.space_id : ""));
  const activeId = registered[0];
  if (activeId === undefined || registered.length !== 1 || active[hostSessionId] !== activeId) {
    throw new Error("synthetic space is not exclusively registered and selected");
  }
  const entry = spaces[0];
  if (!isObject(entry) || !isObject(entry.boundary)) throw new Error("synthetic space registry entry is invalid");
  const binding: unknown = JSON.parse(await readFile(String(entry.binding_path), "utf8"));
  if (!isObject(binding)) throw new Error("synthetic space binding is not an object");
  const spaceManifest: unknown = JSON.parse(await readFile(String(binding.manifest_path), "utf8"));
  const providerPolicy = isObject(binding.provider_policy) ? binding.provider_policy : {};
  const manifestState = isObject(state) && isObject(state[activeId]) ? state[activeId] : {};
  const freshness = manifestState.qmd_freshness === "fresh" || manifestState.qmd_freshness === "index-stale" ? manifestState.qmd_freshness : "unknown";
  const activeStatus: Record<string, unknown> = {
    space_id: activeId,
    space_root: entry.boundary.space_root,
    records_root: entry.boundary.records_root,
    qmd: {
      collection: binding.qmd_collection_name,
      config_dir: binding.qmd_config_dir,
      cache_home: binding.qmd_cache_home,
    },
    sessions_dir: binding.sessions_dir,
    read_roots: binding.read_roots,
    write_roots: binding.write_roots,
    allowed_models: providerPolicy.allowed_models,
    knowledge_schema_version: isObject(spaceManifest) ? spaceManifest.knowledge_schema_version : undefined,
    packs: binding.installed_packs,
    compatibility: "compatible",
    qmd_freshness: freshness,
    session_boundary: "validated-not-enforced",
  };
  const status: Record<string, unknown> = {
    schema_version: 0,
    registered_spaces: registered,
    active_spaces: { [hostSessionId]: activeStatus },
    last_boundary_error: registry.last_boundary_error ?? null,
  };
  return { status, active: activeStatus };
}

/**
 * Builds a real, self-contained synthetic release source (a real git repo
 * with a runnable `bin/engram` and the actual `release/engram-release.ts`
 * bootstrap, so a packaged bootstrap built from it genuinely
 * installs/selects). Does not register the source for cleanup — the
 * caller pushes the returned source into its own `sources` array, same
 * as a plain `createSyntheticReleaseSource()` call.
 */
export async function prepareQualifiableSource(): Promise<SyntheticReleaseSource> {
  const source = await createSyntheticReleaseSource();
  await replaceSyntheticReleaseFile(source, "bin/engram", RUNNABLE_QUALIFICATION_ENGRAM, true);
  const realBootstrap = await readFile(new URL("../../release/engram-release.ts", import.meta.url), "utf8");
  await replaceSyntheticReleaseFile(source, "release/engram-release.ts", realBootstrap);
  return source;
}

/**
 * Prepares a qualifiable synthetic source and qualifies/publishes it
 * end-to-end via `qualifyAndPublishR0`. By default the expensive gate
 * commands (`npm test`/`typecheck`/`mutation-check`) and the
 * `qmd status` probe are stubbed — this never runs the full harness
 * suite or touches ambient qmd — while git, archive staging, bootstrap
 * install/select, the stable commands, and the A/B/A rollback all run for
 * real. Scratch resources are registered for `destroyQualificationScratch`
 * rather than cleaned up here, since the returned result's `recordPath`
 * etc. live under the (surviving) output root.
 */
export async function qualifySyntheticRelease(
  runner: QualificationRunner = createStubbedGateRunner(),
): Promise<QualificationResult<QualificationOutput>> {
  const source = await prepareQualifiableSource();
  qualificationSources.push(source);

  const qualificationRoot = await mkdtemp(join(tmpdir(), "engram-r0-qualification-root-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "engram-r0-qualification-output-"));
  qualificationScratchRoots.push(qualificationRoot, outputRoot);

  return qualifyAndPublishR0({
    repoRoot: source.root,
    qualificationRoot,
    outputRoot,
    manualContentReview: "passed",
    runner,
  });
}
