// Every qmd invocation made on behalf of a space runs with QMD_CONFIG_DIR
// and XDG_CACHE_HOME set to space-owned paths, and nothing else in this
// codebase is permitted to spawn qmd.
//
// SAFETY BOUNDARY — read before touching this file:
//   `runQmd` is the ONLY function in this codebase allowed to spawn the
//   qmd child process. Every other module that needs qmd (refresh, and
//   test fixture setup) must call through `runQmd`, never `child_process`
//   directly. This is what makes it structurally impossible — not merely
//   policy — for a defect elsewhere to widen scope into the user's real
//   personal qmd collections.
//
// Before it spawns anything, `runQmd` runs a preflight check
// (`preflightCheck`): the bound config directory must not be the user's
// real default `~/.config/qmd`, and — if a config file already exists at
// the bound location — its content must validate (exactly one collection,
// matching name/path, no `update:` field; see qmdConfigGuard.ts). For
// commands that make qmd scan the filesystem (`update`, `collection add`),
// it also refuses if any entry under the records root is a symlink
// resolving outside it (symlinkGuard.ts). A refusal never spawns qmd.
//
// `buildQmdInvocation` stays pure (no process spawned) so tests can assert
// on the constructed command/args/env/cwd directly. `runQmd` accepts an
// injectable `spawnFn` (defaulting to the real `child_process.spawn`) so
// tests can also assert on what the spawn boundary itself receives and
// simulate spawn success/failure deterministically, without mocking
// `child_process` globally.

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDefaultQmdCacheHome, isDefaultQmdConfigDir, validateBoundQmdConfig } from "./qmdConfigGuard.ts";
import type { SpaceBinding } from "./spaceBinding.ts";
import { verifyNoSymlinkEscape } from "./symlinkGuard.ts";
import { err, ok, type EnvLike, type Result } from "./types.ts";

export type QmdInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

/**
 * Pure: constructs the exact command/args/cwd/env that would be spawned,
 * without spawning anything. `baseEnv` defaults to the real process
 * environment but is overridable so tests can inject a hostile-looking
 * base environment (e.g. one that already has INDEX_PATH or
 * QMD_CONFIG_DIR pointed at real personal collections) and assert those
 * values never survive into the constructed invocation.
 */
export function buildQmdInvocation(args: string[], binding: SpaceBinding, baseEnv: EnvLike = process.env): QmdInvocation {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }

  // qmd allows INDEX_PATH to override the index location outright (see
  // qmd's store.ts getDefaultDbPath). If that var leaked in from the
  // invoking host's environment it would silently bypass XDG_CACHE_HOME
  // scoping, so it is always cleared here regardless of baseEnv.
  delete env.INDEX_PATH;

  env.QMD_CONFIG_DIR = binding.qmdConfigDir;
  env.XDG_CACHE_HOME = binding.qmdCacheHome;

  // qmd reads process.env.PWD (falling back to the real cwd) in several
  // places that resolve relative/"." paths. child_process.spawn sets the
  // OS-level cwd correctly regardless, but a stale inherited PWD would
  // still be visible to qmd's own process.env.PWD lookup, so it is set to
  // match cwd explicitly rather than left as whatever the harness process
  // happened to inherit.
  env.PWD = binding.recordsRoot;

  return { command: "qmd", args, cwd: binding.recordsRoot, env };
}

/** The minimal surface of a spawned child process this module needs. Node's
 * real ChildProcess (returned by child_process.spawn) satisfies this
 * structurally; tests can substitute a much smaller fake without needing to
 * implement all of ChildProcess. */
export type QmdChildProcess = {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
};

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => QmdChildProcess;

const realSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options);

export type QmdExecution = {
  /** True iff the OS actually started the process (Node's 'spawn' event
   * fired). False means qmd never ran at all — either the preflight
   * refused before spawning, or the spawn itself failed (e.g. ENOENT). */
  ranProcess: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
};

async function executeQmdInvocation(invocation: QmdInvocation, spawnFn: SpawnFn): Promise<QmdExecution> {
  return new Promise((resolvePromise) => {
    const child = spawnFn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env });

    let stdout = "";
    let stderr = "";
    let ranProcess = false;
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("spawn", () => {
      ranProcess = true;
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      resolvePromise({ ranProcess, code: null, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolvePromise({ ranProcess, code, stdout, stderr });
    });
  });
}

function commandScansFilesystem(args: string[]): boolean {
  if (args[0] === "update") return true;
  if (args[0] === "collection" && args[1] === "add") return true;
  return false;
}

async function preflightCheck(args: string[], binding: SpaceBinding): Promise<Result<void>> {
  if (await isDefaultQmdConfigDir(binding.qmdConfigDir)) {
    return err([
      "the bound qmd config directory resolves to the user's default (~/.config/qmd); refusing to touch it",
    ]);
  }

  if (await isDefaultQmdCacheHome(binding.qmdCacheHome)) {
    return err([
      "the bound qmd cache home resolves to the user's default (~/.cache); refusing to touch it, since qmd would write to the personal index",
    ]);
  }

  const configPath = join(binding.qmdConfigDir, "index.yml");
  if (existsSync(configPath)) {
    const configResult = await validateBoundQmdConfig(configPath, binding);
    if (!configResult.ok) return configResult;
  }

  if (commandScansFilesystem(args)) {
    const symlinkResult = await verifyNoSymlinkEscape(binding.recordsRoot);
    if (!symlinkResult.ok) return symlinkResult;
  }

  return ok(undefined);
}

/**
 * THE single function in this codebase permitted to spawn qmd. Refresh,
 * collection bootstrap, and test-fixture setup all route through this, so
 * the preflight check and the scoped environment built by
 * buildQmdInvocation are never bypassed. A preflight refusal returns a
 * QmdExecution with ranProcess: false and never calls spawnFn.
 */
export async function runQmd(args: string[], binding: SpaceBinding, spawnFn: SpawnFn = realSpawn): Promise<QmdExecution> {
  const preflight = await preflightCheck(args, binding);
  if (!preflight.ok) {
    return { ranProcess: false, code: null, stdout: "", stderr: `refused before invocation: ${preflight.errors.join("; ")}` };
  }
  const invocation = buildQmdInvocation(args, binding);
  return executeQmdInvocation(invocation, spawnFn);
}

/**
 * Either the collection already existed (nothing was run), or it didn't
 * and a `collection add` call was actually started — carrying that
 * call's QmdExecution so the caller can assess success/freshness from it
 * directly, instead of also running `update` right afterward.
 */
export type EnsureCollectionOutcome = { provisioned: false } | { provisioned: true; execution: QmdExecution };

/**
 * Creates the bound qmd collection if it doesn't exist yet. Binding
 * registration deliberately performs no index scan, so the first committed
 * operation bootstraps the collection as its one refresh.
 *
 * `qmd collection add` indexes the collection as part of creating it
 * (verified against qmd's own collectionAdd, which calls indexFiles
 * internally and emits the same "Indexed: ..." line `update` does). This
 * only reports whether the process ran at all (ranProcess: false is a
 * genuine "provisioning never happened" failure); it does NOT judge
 * success/freshness from the exit code, because the caller
 * (refreshQmdCollection) needs to apply that judgment uniformly to
 * whichever call — this one or a plain `update` — ends up being this
 * invocation's one refresh.
 */
export async function ensureBoundCollection(
  binding: SpaceBinding,
  spawnFn: SpawnFn = realSpawn,
): Promise<Result<EnsureCollectionOutcome>> {
  const configPath = join(binding.qmdConfigDir, "index.yml");
  if (existsSync(configPath)) {
    return ok({ provisioned: false });
  }

  const execution = await runQmd(
    ["collection", "add", binding.recordsRoot, "--name", binding.qmdCollectionName, "--mask", "*.md"],
    binding,
    spawnFn,
  );

  if (!execution.ranProcess) {
    return err([`qmd collection setup never ran: ${execution.stderr.trim().slice(0, 300)}`]);
  }

  return ok({ provisioned: true, execution });
}

type RefreshReportBase = {
  /** Number of `qmd update` invocations that actually ran to completion
   * for this refresh — computed from whether the process really started
   * and exited, never a hard-coded literal. 0 covers both "refresh was
   * never attempted" and "the update process never started"; the detail
   * string distinguishes the two. */
  detail: string;
};

export type AttemptedRefreshReport = RefreshReportBase & {
  attempted: true;
  count: 0 | 1;
  state: "fresh" | "index-stale";
};

export type SkippedStaleRefreshReport = RefreshReportBase & {
  attempted: false;
  count: 0;
  state: "index-stale";
};

export type NotAttemptedRefreshReport = RefreshReportBase & {
  attempted: false;
  count: 0;
  state: "not-attempted";
};

export type FreshnessRefreshReport = AttemptedRefreshReport | SkippedStaleRefreshReport;

export type RefreshReport = FreshnessRefreshReport | NotAttemptedRefreshReport;

export const REFRESH_NOT_ATTEMPTED: NotAttemptedRefreshReport = {
  attempted: false,
  count: 0,
  state: "not-attempted",
  detail: "no write occurred, so refresh was not attempted",
};

function stripAnsi(text: string): string {
  return text
    // OSC sequences: ESC ] ... (BEL | ESC \)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    // CSI sequences: ESC [ ... letter
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\r/g, "");
}

const INDEXED_LINE_PATTERN = /Indexed:\s*\d+ new,\s*\d+ updated,\s*\d+ unchanged,\s*\d+ removed/;

/**
 * Refreshes the space's bound qmd collection exactly once — meaning
 * exactly one qmd indexing pass, not exactly one qmd subcommand. When the
 * collection has never been provisioned, `collection add` itself scans
 * and indexes the tree, so THAT call is this invocation's one refresh and
 * `update` is not also run afterward (that would be a second, redundant
 * scan of the same records root, reported as if it were still "once").
 * When the collection already exists, the one call is a plain `update`.
 *
 * Fails closed either way: a nonzero exit code, a process that never
 * started, a preflight refusal, or stdout that does not contain the
 * expected "Indexed: ..." line all report `index-stale` rather than being
 * assumed fresh. qmd's own output is human prose with terminal escape
 * sequences and no machine-readable mode, so this is a
 * best-effort parse, not a guarantee.
 */
export async function refreshQmdCollection(binding: SpaceBinding, spawnFn: SpawnFn = realSpawn): Promise<AttemptedRefreshReport> {
  const ensureResult = await ensureBoundCollection(binding, spawnFn);
  if (!ensureResult.ok) {
    return {
      attempted: true,
      count: 0,
      state: "index-stale",
      detail: `qmd collection provisioning never ran, so refresh never ran: ${ensureResult.errors.join("; ")}`,
    };
  }

  const outcome = ensureResult.value;
  const execution = outcome.provisioned ? outcome.execution : await runQmd(["update"], binding, spawnFn);
  const ranCommand = outcome.provisioned ? "collection add" : "update";

  if (!execution.ranProcess) {
    return {
      attempted: true,
      count: 0,
      state: "index-stale",
      detail: `qmd ${ranCommand} never ran: ${execution.stderr.trim().slice(0, 500)}`,
    };
  }

  const cleanStdout = stripAnsi(execution.stdout);
  const sawIndexedLine = INDEXED_LINE_PATTERN.test(cleanStdout);

  if (execution.code === 0 && sawIndexedLine) {
    return { attempted: true, count: 1, state: "fresh", detail: cleanStdout.trim() };
  }

  return {
    attempted: true,
    count: 1,
    state: "index-stale",
    detail:
      `qmd ${ranCommand} ran but did not report success: exit code ${execution.code}; ` +
      (sawIndexedLine ? "" : "no recognizable 'Indexed: ...' line in stdout; ") +
      `stderr: ${execution.stderr.trim().slice(0, 500)}`,
  };
}

/** Outcome of the vector-embedding pass. Reported separately from a refresh
 * because embedding is a different operation on a different derived artifact:
 * `update` maintains the full-text index, `embed` maintains the vectors that
 * back `vsearch`. A caller that refreshes without embedding leaves semantic
 * search stale for the records it just wrote, so the two states must not be
 * collapsed into one "qmd is fine" flag. */
export type EmbedReport = {
  attempted: boolean;
  state: "embedded" | "embeddings-stale";
  detail: string;
};

/**
 * Rebuilds vector embeddings for the bound space.
 *
 * Deliberately NOT called by `refreshQmdCollection`, `submitKnowledgeCandidate`,
 * or the knowledge transaction. Two reasons, both load-bearing:
 *
 * 1. `refreshQmdCollection`'s pinned property is exactly one indexing pass per
 *    committed change. Embedding is not an indexing pass — it reads the index
 *    that pass just wrote — but folding it in would still make every caller
 *    spawn a second qmd process, which is not what "refresh" means.
 * 2. Embedding runs an embedding model over every changed chunk. Doing it once
 *    per committed record would run it N times for a batch of N writes. It
 *    belongs at the boundary of a batch, which is where a caller invokes it.
 *
 * `qmd embed` takes no collection argument: it embeds whatever the resolved
 * configuration contains. That is correct because a space's
 * configuration contains only that space's collections — and it is exactly why
 * this must go through `runQmd`, which scopes `QMD_CONFIG_DIR` and
 * `XDG_CACHE_HOME`. Spawned directly it would reach the ambient personal index.
 */
export async function embedBoundCollection(binding: SpaceBinding, spawnFn: SpawnFn = realSpawn): Promise<EmbedReport> {
  const execution = await runQmd(["embed"], binding, spawnFn);

  if (!execution.ranProcess) {
    return {
      attempted: true,
      state: "embeddings-stale",
      detail: `qmd embed never started: ${execution.stderr.trim().slice(0, 500)}`,
    };
  }

  if (execution.code === 0) {
    return { attempted: true, state: "embedded", detail: stripAnsi(execution.stdout).trim() };
  }

  return {
    attempted: true,
    state: "embeddings-stale",
    detail: `qmd embed ran but exit code ${execution.code}; stderr: ${execution.stderr.trim().slice(0, 500)}`,
  };
}
