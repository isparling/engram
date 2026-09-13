/**
 * Oh My Pi extension for engram knowledge capture.
 *
 * Hooks into the agent lifecycle to extract ambient knowledge candidates
 * from settled turns, and registers two typed, hash-bound capture tools:
 *
 *   engram_capture_preview({ change_set })
 *   engram_capture_apply({ plan_hash })
 *
 * ## Installation
 *
 * Install `@isparling/engram-omp` and point Oh My Pi at it via `--extension`
 * or settings:
 *
 *   extensions:
 *     - @isparling/engram-omp
 *
 * ## Configuration
 *
 * Environment variables read at session start:
 *
 *   ENGRAM_BINDING_REGISTRY  (required)  path to the engram binding registry
 *   ENGRAM_CLI               (optional)  path to engram CLI binary (default: "engram")
 *   ENGRAM_SPACE_ID          (optional)  override nearest engram.space.json
 *   ENGRAM_PROJECT_ROOT      (optional)  artifact root handed to pack
 *                                        materializers (default: process cwd)
 *
 * ## Design
 *
 * Two capture paths:
 *
 *   Hook (session_stop): receives the settled transcript's latest user turn →
 *                        builds TurnContext → invokes the binding-selected
 *                        pack's optional captureFromTurn(turn, tools). The
 *                        pack owns draft policy; the extension confines writes
 *                        to recordsRoot and refreshes scoped qmd. Packs without
 *                        the handler fall back to `engram capture-from-turn`.
 *   Tools (explicit capture): the agent supplies a structured change set →
 *                        the pack's previewStructuredCapture builds the
 *                        candidate and calls back into the host's
 *                        `engram knowledge reconcile`; the extension stores
 *                        the resulting plan hash plus the candidate privately.
 *                        Approval runs `engram knowledge approve --expect
 *                        <plan-hash>` against that exact candidate, then hands
 *                        the applied mutation view to the pack's materialize.
 *                        The candidate envelope never appears in any tool
 *                        result; only the mutation summary does.
 *
 * The extension owns only OMP lifecycle and host mechanics. Capture policy
 * remains external-pack code; core transaction behavior stays unchanged.
 *
 * @module
 */

import { chmod, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ArtifactReplacementResult,
  CaptureMutationView,
  CompletionRequest,
  HostCapturePreview,
} from "@isparling/engram-harness/capture-types";
import type {
  HostSessionProvenance,
  JsonValue,
  KnowledgeEnvelope,
  KnowledgeError,
  KnowledgeRecord,
  TurnContext,
  TurnToolCall,
} from "@isparling/engram-harness/knowledge-types";

// ---------------------------------------------------------------------------
// ExtensionAPI types — mirrors the real omp type from
// @oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts
// ---------------------------------------------------------------------------

export interface ExtensionAPI {
  on(event: "session_stop", handler: (event: SessionStopEvent, ctx: ExtensionContext) => void | Promise<void>): void;
  registerTool(tool: ToolDefinition): void;
  logger: { info: (message: string) => void; warn: (message: string) => void };
}

export interface SessionStopEvent {
  type: "session_stop";
  messages: unknown[];
  session_id: string;
  session_file: string;
  turn_id: number;
  last_assistant_message?: unknown;
  stop_hook_active: boolean;
  signal: AbortSignal;
}

export interface ExtensionContext {
  cwd: string;
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<ToolResult>;
}

/**
 * A spawned headless completion process. Mirrors the subset of Bun's
 * Subprocess the extension consumes, so tests can inject a seam without
 * launching a real child OMP.
 */
export type OmpCompletionProcess = {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

/** Injectable child-OMP spawn seam. Production uses `Bun.spawn`. */
export type OmpSpawn = (
  argv: string[],
  options: { signal: AbortSignal },
) => OmpCompletionProcess;

/** Test-only construction seam for the extension factory. */
export type ExtensionOptions = {
  spawnOmp?: OmpSpawn;
};

export type CaptureTools = {
  recordsRoot: string;
  spaceId: string;
  projectRoot: string;
  writeFile(path: string, content: string): Promise<void>;
  refreshIndex(): Promise<void>;
  complete(request: CompletionRequest): Promise<string>;
};

export type CaptureSummary = {
  created: string[];
  existing: string[];
  invalid: Array<{ id: string; errors: string[] }>;
  warnings: string[];
};

export type CaptureHandler = (
  turn: TurnContext,
  tools: CaptureTools,
) => Promise<CaptureSummary>;

/** Host mechanics handed to a pack's previewStructuredCapture. */
export type StructuredPreviewTools = {
  spaceId: string;
  previewCandidate(candidate: KnowledgeEnvelope): Promise<HostCapturePreview>;
};

/** Host mechanics handed to a pack's materialize. */
export type StructuredMaterializeTools = {
  listRecords(): Promise<KnowledgeRecord[]>;
  replaceArtifact(request: {
    root: string;
    relativePath: string;
    content: string;
  }): Promise<ArtifactReplacementResult>;
  projectRoot: string;
  appliedAt: string;
};

export type PackStructuredPreview = (
  changeSet: { [key: string]: JsonValue },
  tools: StructuredPreviewTools,
) => Promise<unknown>;

export type PackMaterialize = (
  appliedPlan: { planHash: string; mutations: CaptureMutationView[] },
  tools: StructuredMaterializeTools,
) => Promise<unknown>;

/**
 * Resolution of the binding-selected pack module. Pack identity is validated
 * once; each capture export is recorded independently and stays optional.
 * A pack selected with `extract: true` is valid when it exports
 * `captureFromTurn` — its root pack object need not implement
 * `KnowledgeExtractor.extractCandidates`.
 */
export type CaptureResolution =
  | {
      kind: "available";
      captureFromTurn: CaptureHandler;
      previewStructuredCapture?: PackStructuredPreview;
      materialize?: PackMaterialize;
    }
  | { kind: "absent" }
  | { kind: "failed"; message: string };

/**
 * A pending explicit-capture plan keyed by its immutable plan hash.
 *
 * State machine:
 *   previewed         → apply committed/no-change → records-committed
 *   previewed         → apply stale              → (entry deleted; fresh
 *                                                  preview required)
 *   records-committed → apply (same hash) reruns ONLY materialize → deleted
 */
type PendingCapture = {
  sessionId: string;
  candidate: KnowledgeEnvelope;
  preview: Extract<HostCapturePreview, { status: "ready" }>;
  state: "previewed" | "records-committed";
  appliedPlan?: { planHash: string; mutations: CaptureMutationView[] };
  /** One captured apply timestamp, reused verbatim across materialize retries. */
  appliedAt?: string;
  appliedStatus?: "committed" | "no-change";
  indexState: "fresh" | "stale" | "not-attempted";
};

function stopTurnKey(event: SessionStopEvent): string {
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index];
    if (
      typeof message === "object" &&
      message !== null &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).role === "user"
    ) {
      const record = message as Record<string, unknown>;
      const content = JSON.stringify(record.content);
      const identity = typeof record.id === "string"
        ? record.id
        : typeof record.timestamp === "string" || typeof record.timestamp === "number"
          ? `${record.timestamp}:${content}`
          : content;
      return `${event.session_id}:${event.turn_id}:${identity}`;
    }
  }
  return `${event.session_id}:${event.turn_id}:no-user-message`;
}


function packExport(module: Record<string, unknown>, id: string): unknown {
  const camelId = id.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  const direct = module[id] ?? module[camelId] ?? module.default;
  if (direct !== undefined) return direct;
  const registry = module.packs ?? module.packRegistry;
  return typeof registry === "object" && registry !== null && !Array.isArray(registry)
    ? (registry as Record<string, unknown>)[id]
    : undefined;
}
function toolText(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}
async function nativePackageSpecifier(specifier: string): Promise<string> {
  const parentUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const proc = Bun.spawn([
    "node",
    "--experimental-import-meta-resolve",
    "--input-type=module",
    "-e",
    "console.log(import.meta.resolve(process.argv[1], process.argv[2]))",
    specifier,
    parentUrl,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  if (exitCode !== 0 || stdout === "") {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`native ESM resolution failed: ${stderr.slice(0, 500)}`);
  }
  return stdout;
}

// ---------------------------------------------------------------------------
// JSON narrowing helpers
// ---------------------------------------------------------------------------

function isJsonObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value);
}

function isJsonRecord(value: unknown): value is { [key: string]: JsonValue } {
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}

function parseKnowledgeError(value: unknown): KnowledgeError | undefined {
  if (!isJsonObject(value)) return undefined;
  if (typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  return {
    kind: typeof value.kind === "string" ? value.kind as KnowledgeError["kind"] : "validation",
    code: value.code,
    ...(typeof value.field === "string" ? { field: value.field } : {}),
    message: value.message,
  };
}

function parseKnowledgeErrors(value: unknown): KnowledgeError[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const errors: KnowledgeError[] = [];
  for (const item of value) {
    const parsed = parseKnowledgeError(item);
    if (parsed === undefined) return undefined;
    errors.push(parsed);
  }
  return errors;
}

/** The public shape a pack's previewStructuredCapture must return when ready. */
type PackPreviewReady = {
  schemaVersion: 0;
  status: "ready";
  planHash: string;
  candidate: KnowledgeEnvelope;
  changes: Array<{ [key: string]: JsonValue }>;
  artifacts: string[];
};

function parsePackPreview(
  value: unknown,
): PackPreviewReady | { status: "blocked"; errors: KnowledgeError[] } | undefined {
  if (!isJsonObject(value) || value.schemaVersion !== 0) return undefined;
  if (value.status === "blocked") {
    const errors = parseKnowledgeErrors(value.errors);
    return errors === undefined ? undefined : { status: "blocked", errors };
  }
  if (value.status !== "ready") return undefined;
  if (typeof value.planHash !== "string" || value.planHash.length === 0) return undefined;
  if (!isJsonObject(value.candidate) || typeof value.candidate.id !== "string") return undefined;
  if (!Array.isArray(value.changes) || !Array.isArray(value.artifacts)) return undefined;
  const changes: PackPreviewReady["changes"] = [];
  for (const change of value.changes) {
    if (!isJsonRecord(change)) return undefined;
    changes.push(change);
  }
  const artifacts: string[] = [];
  for (const artifact of value.artifacts) {
    if (typeof artifact !== "string" || artifact.length === 0) return undefined;
    artifacts.push(artifact);
  }
  return {
    schemaVersion: 0,
    status: "ready",
    planHash: value.planHash,
    candidate: value.candidate as KnowledgeEnvelope,
    changes,
    artifacts,
  };
}

/** Serialized planned-mutation shape printed by the knowledge CLI. */
type CliPlannedMutation = {
  recordId: unknown;
  action: unknown;
  beforeHash: unknown;
  after: unknown;
};

function parseCliMutations(value: unknown): CaptureMutationView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const mutations: CaptureMutationView[] = [];
  for (const raw of value) {
    if (!isJsonObject(raw)) return undefined;
    const source = raw as unknown as CliPlannedMutation;
    if (typeof source.recordId !== "string") return undefined;
    if (source.action !== "create" && source.action !== "update") return undefined;
    if (source.beforeHash !== null && typeof source.beforeHash !== "string") return undefined;
    if (!isJsonObject(source.after)) return undefined;
    const after = parseKnowledgeRecordShape(source.after);
    if (after === undefined) return undefined;
    mutations.push({
      recordId: source.recordId,
      action: source.action,
      beforeHash: source.beforeHash,
      after,
    });
  }
  return mutations;
}

/** Structural validation of a CLI-reported knowledge record. */
function parseKnowledgeRecordShape(value: { [key: string]: unknown }): KnowledgeRecord | undefined {
  if (
    typeof value.id !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.status !== "string" ||
    typeof value.statement !== "string" ||
    !isJsonObject(value.details) ||
    !isJsonObject(value.scope) ||
    !isJsonObject(value.pack) ||
    !Array.isArray(value.sources) ||
    !isJsonObject(value.session) ||
    typeof value.submittedAt !== "string" ||
    typeof value.disposition !== "string" ||
    value.schemaVersion !== 0 ||
    !isJsonObject(value.relationships) ||
    !Array.isArray(value.history)
  ) {
    return undefined;
  }
  const scope = value.scope as unknown as KnowledgeRecord["scope"];
  if (!Array.isArray(scope.subjects) || !Array.isArray(scope.topics)) return undefined;
  const relationships = value.relationships as unknown as KnowledgeRecord["relationships"];
  for (const key of ["supports", "contradicts", "refines", "supersedes"] as const) {
    if (!Array.isArray(relationships[key])) return undefined;
  }
  return value as unknown as KnowledgeRecord;
}

type CliApplyCommitted = {
  status: "committed" | "no_change";
  mutations: CaptureMutationView[];
  index: "fresh" | "stale" | "not-attempted";
};

function mapRefreshIndex(refresh: unknown): "fresh" | "stale" | "not-attempted" {
  if (!isJsonObject(refresh) || refresh.attempted !== true) return "not-attempted";
  return refresh.state === "fresh" ? "fresh" : "stale";
}

function parseCliApplyOutcome(stdout: string): CliApplyCommitted | { status: "stale_approval" } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) return undefined;
  if (parsed.status === "stale_approval") return { status: "stale_approval" };
  if (parsed.status !== "committed" && parsed.status !== "no_change") return undefined;
  const mutations = parseCliMutations(parsed.mutations);
  if (mutations === undefined) return undefined;
  return { status: parsed.status, mutations, index: mapRefreshIndex(parsed.refresh) };
}

function parseArtifactReplacement(stdout: string): ArtifactReplacementResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) return undefined;
  if ((parsed.status !== "replaced" && parsed.status !== "unchanged") || typeof parsed.path !== "string") {
    return undefined;
  }
  return { status: parsed.status, path: parsed.path };
}

function parseListedRecords(stdout: string): KnowledgeRecord[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed) || parsed.status !== "ok" || !Array.isArray(parsed.records)) return undefined;
  const records: KnowledgeRecord[] = [];
  for (const raw of parsed.records) {
    if (!isJsonObject(raw)) return undefined;
    const record = parseKnowledgeRecordShape(raw);
    if (record === undefined) return undefined;
    records.push(record);
  }
  return records;
}

/** Mechanical mutation summary: no domain interpretation beyond field reads. */
function summarizeMutations(mutations: CaptureMutationView[]): {
  created: string[];
  retired: string[];
  entityKeys: string[];
} {
  const created: string[] = [];
  const retired = new Set<string>();
  const entityKeys = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.action === "create") created.push(mutation.recordId);
    const supersedes = mutation.after.relationships.supersedes;
    for (const id of Array.isArray(supersedes) ? supersedes : []) {
      if (typeof id === "string" && !created.includes(id)) retired.add(id);
    }
    const entityKey = mutation.after.details.entityKey;
    if (typeof entityKey === "string") entityKeys.add(entityKey);
  }
  return {
    created,
    retired: [...retired].sort(),
    entityKeys: [...entityKeys].sort(),
  };
}

type MaterializationOutcome = {
  written: ArtifactReplacementResult[];
  unchanged: ArtifactReplacementResult[];
  stale: Array<{ path: string; reason: string }>;
};

function normalizeMaterialization(value: unknown): MaterializationOutcome {
  const empty: MaterializationOutcome = { written: [], unchanged: [], stale: [] };
  if (!isJsonObject(value)) return empty;
  const results = (raw: unknown): ArtifactReplacementResult[] => {
    if (!Array.isArray(raw)) return [];
    const out: ArtifactReplacementResult[] = [];
    for (const item of raw) {
      if (!isJsonObject(item)) continue;
      if ((item.status !== "replaced" && item.status !== "unchanged") || typeof item.path !== "string") continue;
      out.push({ status: item.status, path: item.path });
    }
    return out;
  };
  const stale: Array<{ path: string; reason: string }> = [];
  if (Array.isArray(value.stale)) {
    for (const item of value.stale) {
      if (!isJsonObject(item)) continue;
      if (typeof item.path !== "string" || typeof item.reason !== "string") continue;
      stale.push({ path: item.path, reason: item.reason });
    }
  }
  return { written: results(value.written), unchanged: results(value.unchanged), stale };
}

// ---------------------------------------------------------------------------
// CLI format helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a candidate envelope to CLI IO format.
 *
 * The CLI's `validateKnowledgeEnvelope` expects `submitted_at` (snake_case,
 * YYYY-MM-DD) and rejects `submittedAt` (camelCase) as an unknown field.
 * This helper strips the camelCase variant, sets the snake_case variant,
 * and returns a plain Record suitable for JSON.stringify.
 */
function toCliCandidate(input: object): Record<string, unknown> {
  const raw = input as Record<string, unknown>;
  const rawDate = raw.submittedAt ?? raw.submitted_at;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (key !== "submittedAt") out[key] = raw[key];
  }
  out.submitted_at = rawDate !== undefined
    ? String(rawDate).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return out;
}

/**
 * Write one candidate envelope to a fresh mode-0600 file inside a mode-0700
 * temporary directory, hand the file path to the caller, and always remove
 * the directory afterwards.
 */
async function withTempCandidate<T>(candidate: object, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "engram-candidate-"));
  try {
    await chmod(dir, 0o700);
    const file = join(dir, "candidate.json");
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(toCliCandidate(candidate)), "utf8");
    } finally {
      await handle.close();
    }
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Same confinement for arbitrary generated-artifact content. */
async function withTempContent<T>(content: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "engram-artifact-"));
  try {
    await chmod(dir, 0o700);
    const file = join(dir, "artifact.content");
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/**
 * Resolve the engram CLI binary to shell out to.
 *
 * Priority: an explicit ENGRAM_CLI, then the sibling @isparling/engram-cli
 * package when it is installed alongside @isparling/engram-omp, then the
 * `engram` command on PATH.
 */
function resolveCliPath(): string {
  const explicit = process.env.ENGRAM_CLI;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  try {
    return fileURLToPath(import.meta.resolve("@isparling/engram-cli/bin/engram"));
  } catch {
    return "engram";
  }
}

/**
 * Attribute a headless-completion failure to the precise cause the pack
 * must distinguish. Cancellation wins over the deadline: an aborted stop
 * hook means the whole turn is going away, not that the model was slow.
 */
function completionFailure(
  signal: AbortSignal,
  deadline: AbortSignal,
  detail: string,
): Error {
  if (signal.aborted) return new Error(`capture_cancelled: ${detail}`);
  if (deadline.aborted) return new Error(`capture_timeout: ${detail}`);
  return new Error(`capture_model_failed: ${detail}`);
}

/** Artifact root handed to packs; defaults to the process working directory. */
function artifactProjectRoot(): string {
  const configured = process.env.ENGRAM_PROJECT_ROOT;
  return configured !== undefined && configured.length > 0 ? configured : process.cwd();
}

export default async function engramExtension(
  api: ExtensionAPI,
  options: ExtensionOptions = {},
): Promise<void> {
  // Production spawns a real child OMP; tests inject a seam so the exact
  // isolation argv can be asserted without launching a model.
  const spawnOmp: OmpSpawn = options.spawnOmp ?? ((argv, spawnOptions) =>
    Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      signal: spawnOptions.signal,
    }));
  const cliPath = resolveCliPath();
  const registryPath = process.env.ENGRAM_BINDING_REGISTRY;

  if (registryPath === undefined || registryPath.length === 0) {
    api.logger.warn("[engram] ENGRAM_BINDING_REGISTRY not set — knowledge capture disabled");
    return;
  }

  const bindingRegistryPath = registryPath;


  // Session identifier — captured from OMP's awaited session_stop payload.
  // Before the first final settle, CLI tools use "pending" and status reports
  // no resolved pack.
  let hostSessionId: string | undefined;

  /** Build env for CLI calls, including the session id resolveActiveSpace requires. */
  function cliEnv(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      ENGRAM_BINDING_REGISTRY: bindingRegistryPath,
      ENGRAM_HOST_SESSION_ID: hostSessionId ?? "pending",
    };
  }
  async function configuredSpaceId(cwd: string): Promise<string | undefined> {
    const override = process.env.ENGRAM_SPACE_ID?.trim();
    if (override !== undefined && override !== "") return override;

    let directory = resolve(cwd);
    while (true) {
      const manifestPath = join(directory, "engram.space.json");
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          schema_version?: unknown;
          space_id?: unknown;
        };
        if (manifest.schema_version !== 0 || typeof manifest.space_id !== "string" || manifest.space_id === "") {
          throw new Error(`invalid Engram space manifest: ${manifestPath}`);
        }
        return manifest.space_id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }

  async function ensureSessionSelection(cwd: string, signal: AbortSignal): Promise<void> {
    const statusProc = Bun.spawn([cliPath, "space", "status"], {
      stdout: "pipe",
      stderr: "pipe",
      env: cliEnv(),
      signal,
    });
    const statusExit = await statusProc.exited;
    if (statusExit === 0) {
      const status = JSON.parse(await new Response(statusProc.stdout).text()) as {
        active_spaces?: Record<string, unknown>;
      };
      if (hostSessionId !== undefined && status.active_spaces?.[hostSessionId] !== undefined) return;
    }

    const spaceId = await configuredSpaceId(cwd);
    if (spaceId === undefined) return;
    signal.throwIfAborted();
    const selectProc = Bun.spawn([cliPath, "space", "select", spaceId], {
      stdout: "pipe",
      stderr: "pipe",
      env: cliEnv(),
      signal,
    });
    const selectExit = await selectProc.exited;
    if (selectExit !== 0) {
      const stdout = await new Response(selectProc.stdout).text();
      const stderr = await new Response(selectProc.stderr).text();
      throw new Error(`automatic space selection failed (exit ${selectExit}): ${(stdout || stderr).slice(0, 500)}`);
    }
  }

  // Active-space state is session-bound. OMP keeps extension instances alive
  // across session switches, so every new session must resolve independently.
  let extractionPackId = "work-pack";
  let extractionPackVersion = "0.1.0";
  let extractionPackFrom: string | undefined;
  let extractionSpaceId = "current";
  let extractionRecordsRoot = "";
  let captureResolution: CaptureResolution | undefined;
  let resolvedPackId = false;
  let lastCapturedTurnKey: string | undefined;

  // Explicit-capture session state.
  const pendingPlans = new Map<string, PendingCapture>();
  let lastIndexState: "fresh" | "stale" | "not-attempted" = "not-attempted";
  const sessionStaleArtifacts: string[] = [];

  function resetSessionResolution(): void {
    extractionPackId = "work-pack";
    extractionPackVersion = "0.1.0";
    extractionPackFrom = undefined;
    extractionSpaceId = "current";
    extractionRecordsRoot = "";
    captureResolution = undefined;
    resolvedPackId = false;
    lastCapturedTurnKey = undefined;
    pendingPlans.clear();
    lastIndexState = "not-attempted";
    sessionStaleArtifacts.length = 0;
  }

  async function bindingPathForActiveSpace(): Promise<string> {
    const registry = JSON.parse(await readFile(bindingRegistryPath, "utf8")) as {
      spaces?: Array<{ space_id?: unknown; binding_path?: unknown }>;
    };
    const entry = registry.spaces?.find((space) => space.space_id === extractionSpaceId);
    if (typeof entry?.binding_path !== "string") {
      throw new Error(`registry omitted binding path for active space ${extractionSpaceId}`);
    }
    return entry.binding_path;
  }

  async function packModuleSpecifier(): Promise<string> {
    if (extractionPackFrom === undefined) throw new Error("active extraction pack omitted from");
    if (extractionPackFrom.startsWith("./") || extractionPackFrom.startsWith("../")) {
      const bindingPath = await bindingPathForActiveSpace();
      return pathToFileURL(resolve(dirname(bindingPath), extractionPackFrom)).href;
    }
    if (isAbsolute(extractionPackFrom)) return pathToFileURL(extractionPackFrom).href;
    if (extractionPackFrom.startsWith("file:")) return extractionPackFrom;
    return nativePackageSpecifier(extractionPackFrom);
  }

  /** Resolve the extraction pack from the active space after final settlement. */
  async function resolveExtractionPack(): Promise<void> {
    if (hostSessionId === undefined || resolvedPackId) return;
    try {
      const proc = Bun.spawn([cliPath, "space", "status"], {
        stdout: "pipe",
        stderr: "pipe",
        env: cliEnv(),
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) return;
      const stdout = await new Response(proc.stdout).text();
      const status = JSON.parse(stdout) as Record<string, unknown>;
      const activeSpaces = status.active_spaces as Record<string, Record<string, unknown>> | undefined;
      const space = activeSpaces?.[hostSessionId];
      if (space === undefined) return;
      extractionSpaceId = String(space.space_id ?? "current");
      extractionRecordsRoot = String(space.records_root ?? "");
      const packs = space.packs as Array<Record<string, unknown>> | undefined;
      const extractPack = packs?.find((pack) => pack.extract === true);
      if (extractPack === undefined) return;
      extractionPackId = String(extractPack.id);
      extractionPackVersion = String(extractPack.version);
      extractionPackFrom = typeof extractPack.from === "string" ? extractPack.from : undefined;
      resolvedPackId = true;
    } catch {
      // Resolution failure remains unresolved and capture stops at the caller.
    }
  }

  /**
   * Resolve the complete capture module surface once per session: pack
   * identity is validated exactly once, and the optional captureFromTurn /
   * previewStructuredCapture / materialize exports are recorded independently.
   * A pack selected with `extract: true` is valid when it exports
   * captureFromTurn; its root pack object need not implement extractCandidates.
   */
  async function resolveCaptureModule(): Promise<CaptureResolution> {
    if (captureResolution !== undefined) return captureResolution;
    try {
      const specifier = await packModuleSpecifier();
      // Runtime-selected by the active binding; a static import cannot model
      // an external pack declaration.
      const module = await import(specifier) as Record<string, unknown>;
      const selected = packExport(module, extractionPackId);
      const identityMatches = typeof selected === "object" &&
        selected !== null &&
        !Array.isArray(selected) &&
        (selected as Record<string, unknown>).id === extractionPackId &&
        (selected as Record<string, unknown>).version === extractionPackVersion;
      if (!identityMatches) {
        captureResolution = { kind: "failed", message: "pack export identity does not match the active binding" };
      } else if (typeof module.captureFromTurn !== "function") {
        captureResolution = { kind: "absent" };
      } else {
        captureResolution = {
          kind: "available",
          captureFromTurn: module.captureFromTurn as CaptureHandler,
          ...(typeof module.previewStructuredCapture === "function"
            ? { previewStructuredCapture: module.previewStructuredCapture as PackStructuredPreview }
            : {}),
          ...(typeof module.materialize === "function"
            ? { materialize: module.materialize as PackMaterialize }
            : {}),
        };
      }
    } catch (error) {
      captureResolution = { kind: "failed", message: String(error) };
    }
    return captureResolution;
  }

  async function captureTools(signal: AbortSignal): Promise<CaptureTools> {
    const recordsRoot = await realpath(extractionRecordsRoot);
    return {
      recordsRoot,
      spaceId: extractionSpaceId,
      projectRoot: artifactProjectRoot(),
      writeFile: async (path, content) => {
        signal.throwIfAborted();
        const target = resolve(path);
        if (target !== recordsRoot && !target.startsWith(recordsRoot + sep)) {
          throw new Error(`capture handler write escaped records root: ${path}`);
        }
        const parent = await realpath(dirname(target));
        if (parent !== recordsRoot && !parent.startsWith(recordsRoot + sep)) {
          throw new Error(`capture handler write escaped records root through a symlink: ${path}`);
        }
        signal.throwIfAborted();
        const handle = await open(join(parent, basename(target)), "wx");
        try {
          signal.throwIfAborted();
          await handle.writeFile(content, "utf8");
        } finally {
          await handle.close();
        }
      },
      refreshIndex: async () => {
        signal.throwIfAborted();
        const proc = Bun.spawn([cliPath, "space", "refresh"], {
          stdout: "pipe",
          stderr: "pipe",
          env: cliEnv(),
          signal,
        });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          throw new Error(`guarded space refresh failed (exit ${exitCode}): ${(stdout || stderr).slice(0, 500)}`);
        }
      },
      complete: async (request) => {
        signal.throwIfAborted();
        // The stop hook and the request's own deadline both terminate the
        // child. Keeping the two signals separate lets the failure be
        // attributed precisely instead of collapsing into one error.
        const deadline = AbortSignal.timeout(request.timeoutSeconds * 1000);
        const combined = AbortSignal.any([signal, deadline]);
        // The system prompt rides in the prompt body: the isolation argv is
        // fixed, and dropping `system` would silently lose pack instructions.
        const prompt = request.system.length > 0
          ? `${request.system}\n\n${request.prompt}`
          : request.prompt;
        const argv = [
          "omp",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--mode",
          "text",
          "--model",
          request.model,
          "-p",
          prompt,
        ];
        const proc = spawnOmp(argv, { signal: combined });
        let exitCode: number;
        try {
          exitCode = await proc.exited;
        } catch (error) {
          throw completionFailure(signal, deadline, `headless completion failed: ${String(error)}`);
        }
        if (signal.aborted || deadline.aborted) {
          throw completionFailure(signal, deadline, "headless completion did not finish");
        }
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(
            `capture_model_failed: headless completion exited ${exitCode}: ${stderr.slice(0, 500)}`,
          );
        }
        return await new Response(proc.stdout).text();
      },
    };
  }

  async function runCli(
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn([cliPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: cliEnv(),
      ...(signal === undefined ? {} : { signal }),
    });
    const exitCode = await proc.exited;
    return {
      exitCode,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    };
  }

  /**
   * Host preview mechanics: write the candidate to a protected temporary
   * file, run `engram knowledge reconcile --candidate <file>`, and map the
   * proposal into a HostCapturePreview. Every invalid/retrieval failure maps
   * to status "blocked". The temporary directory is removed in finally.
   */
  async function previewCandidate(candidate: KnowledgeEnvelope): Promise<HostCapturePreview> {
    return withTempCandidate(candidate, async (file) => {
      const outcome = await runCli(["knowledge", "reconcile", "--candidate", file]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(outcome.stdout);
      } catch {
        parsed = undefined;
      }
      if (outcome.exitCode === 0 && isJsonObject(parsed) && parsed.status === "proposal" && isJsonObject(parsed.proposal)) {
        const proposal = parsed.proposal as { [key: string]: unknown };
        const plan = isJsonObject(proposal.plan) ? proposal.plan as { [key: string]: unknown } : undefined;
        const mutations = plan === undefined ? undefined : parseCliMutations(plan.mutations);
        if (typeof proposal.plan_hash === "string" && mutations !== undefined) {
          return {
            schemaVersion: 0,
            status: "ready",
            planHash: proposal.plan_hash,
            mutations,
          };
        }
      }
      const errors = isJsonObject(parsed) ? parseKnowledgeErrors(parsed.errors) : undefined;
      return {
        schemaVersion: 0,
        status: "blocked",
        errors: errors ?? [{
          kind: "transaction",
          code: "reconcile_failed",
          message: `engram knowledge reconcile failed (exit ${outcome.exitCode}): ${(outcome.stdout || outcome.stderr).slice(0, 500)}`,
        }],
      };
    });
  }

  /**
   * Materialization host mechanics. The adapter never interprets record
   * roles, entity keys, artifact kinds, or output shape: it validates CLI
   * responses structurally and forwards them verbatim.
   */
  function materializeTools(entry: PendingCapture): StructuredMaterializeTools {
    return {
      projectRoot: artifactProjectRoot(),
      appliedAt: (entry.appliedAt ??= new Date().toISOString()),
      listRecords: async () => {
        const outcome = await runCli(["knowledge", "list", "--pack", extractionPackId, "--status", "active"]);
        const records = parseListedRecords(outcome.stdout);
        if (outcome.exitCode !== 0 || records === undefined) {
          throw new Error(
            `engram knowledge list failed (exit ${outcome.exitCode}): ${(outcome.stdout || outcome.stderr).slice(0, 500)}`,
          );
        }
        return records;
      },
      replaceArtifact: async (request) =>
        withTempContent(request.content, async (file) => {
          const outcome = await runCli([
            "artifact",
            "replace",
            "--root",
            request.root,
            "--relative",
            request.relativePath,
            "--input",
            file,
          ]);
          const mapped = parseArtifactReplacement(outcome.stdout);
          if (outcome.exitCode !== 0 || mapped === undefined) {
            throw new Error(
              `engram artifact replace failed (exit ${outcome.exitCode}): ${(outcome.stdout || outcome.stderr).slice(0, 500)}`,
            );
          }
          return mapped;
        }),
    };
  }


  // -----------------------------------------------------------------------
  // Structural capture: awaited final-settle hook
  // -----------------------------------------------------------------------
  api.on("session_stop", async (event: SessionStopEvent, ctx: ExtensionContext) => {
    if (event.signal.aborted) return;
    if (event.session_id === "") {
      api.logger.warn("[engram] session_stop omitted a host session id");
      return;
    }
    if (hostSessionId !== event.session_id) resetSessionResolution();
    hostSessionId = event.session_id;
    try {
      await ensureSessionSelection(ctx.cwd, event.signal);
    } catch (error) {
      if (!event.signal.aborted) api.logger.warn(`[engram] ${String(error)}`);
      return;
    }
    await resolveExtractionPack();
    if (!resolvedPackId) {
      api.logger.warn("[engram] session_stop could not resolve an active extraction pack");
      return;
    }
    if (!Array.isArray(event.messages) || event.messages.length === 0) return;
    const turnKey = stopTurnKey(event);
    if (lastCapturedTurnKey === turnKey) return;

    const turn = buildTurnContext(event);
    if (turn === undefined) return;
    const resolution = await resolveCaptureModule();
    if (resolution.kind === "failed") {
      api.logger.warn(`[engram] failed to load pack capture handler: ${resolution.message}`);
      return;
    }
    if (resolution.kind === "available") {
      try {
        const summary = await resolution.captureFromTurn(turn, await captureTools(event.signal));
        if (event.signal.aborted) return;
        // Ambient capture never blocks the turn, so a silent warning would be
        // invisible: every pack-reported failure surfaces here.
        for (const warning of summary.warnings) {
          api.logger.warn(`[engram] capture warning: ${warning}`);
        }
        api.logger.info(
          `[engram] capture: ${summary.created.length} draft(s), ` +
          `${summary.existing.length} existing, ${summary.invalid.length} invalid, ` +
          `${summary.warnings.length} warning(s)`,
        );
        lastCapturedTurnKey = turnKey;
      } catch (error) {
        if (!event.signal.aborted) api.logger.warn(`[engram] pack capture handler failed: ${String(error)}`);
      }
      return;
    }

    // A successfully loaded pack without a captureFromTurn handler retains
    // the generic CLI path.
    try {
      const proc = Bun.spawn([cliPath, "capture-from-turn"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: cliEnv(),
        signal: event.signal,
      });
      await proc.stdin.write(JSON.stringify(turn) + "\n");
      await proc.stdin.end();

      const exitCode = await proc.exited;
      if (exitCode === 0) lastCapturedTurnKey = turnKey;
      if (exitCode !== 0 && !event.signal.aborted) {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        api.logger.warn(`[engram] capture-from-turn failed (exit ${exitCode}): ${(stdout || stderr).slice(0, 500)}`);
      }
    } catch (error) {
      if (!event.signal.aborted) api.logger.warn(`[engram] failed to invoke engram CLI: ${String(error)}`);
    }
  });

  // -----------------------------------------------------------------------
  // Status tool: report loaded pack, mode, and pending capture state
  // -----------------------------------------------------------------------
  api.registerTool({
    name: "engram_status",
    label: "Engram status",
    description: "Report the binding-selected pack identity, CLI mode, and pending capture state.",
    parameters: { type: "object", properties: {} },
    execute: async () => toolText({
      pack_id: resolvedPackId ? extractionPackId : null,
      pack_version: resolvedPackId ? extractionPackVersion : null,
      mode: "cli",
      pending_plan_hashes: hostSessionId === undefined
        ? []
        : [...pendingPlans.entries()]
            .filter(([, entry]) => entry.sessionId === hostSessionId)
            .map(([hash]) => hash),
      index_state: lastIndexState,
      stale_artifacts: [...sessionStaleArtifacts],
    }),
  });

  // -----------------------------------------------------------------------
  // Explicit capture: engram_capture_preview
  // -----------------------------------------------------------------------
  api.registerTool({
    name: "engram_capture_preview",
    label: "Preview Engram capture",
    description: `Preview a structured knowledge capture against the active engram space.
The binding-selected pack turns your change set into candidate records, the
host reconciles them authoritatively, and you receive the exact mutation plan
bound to an immutable plan hash. Apply that hash with engram_capture_apply.

Parameters:
- change_set: pack-defined JSON object describing what to capture.`,
    parameters: {
      type: "object",
      properties: {
        change_set: { type: "object" },
      },
      required: ["change_set"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (hostSessionId === undefined) {
          return toolText({ status: "error", errors: ["no active engram session; settle a turn first"] });
        }
        const changeSet = params.change_set;
        if (changeSet === undefined || changeSet === null || typeof changeSet !== "object" || Array.isArray(changeSet)) {
          return toolText({ status: "error", errors: ["change_set must be a JSON object"] });
        }
        const resolution = await resolveCaptureModule();
        if (resolution.kind === "failed") {
          return toolText({ status: "error", errors: [`pack load failed: ${resolution.message}`] });
        }
        if (resolution.kind === "absent" || resolution.previewStructuredCapture === undefined) {
          return toolText({ status: "error", errors: ["the binding-selected pack does not expose previewStructuredCapture"] });
        }

        // The host preview happens inside the pack callback; capture it so the
        // pack-declared hash can be verified against the authoritative one.
        let hostPreview: HostCapturePreview | undefined;
        const packResult = await resolution.previewStructuredCapture(
          changeSet as { [key: string]: JsonValue },
          {
            spaceId: extractionSpaceId,
            previewCandidate: async (candidate) => {
              hostPreview = await previewCandidate(candidate);
              return hostPreview;
            },
          },
        );
        const parsed = parsePackPreview(packResult);
        if (parsed === undefined) {
          return toolText({ status: "error", errors: ["pack returned a malformed structured capture preview"] });
        }
        if (parsed.status === "blocked") {
          return toolText({ status: "blocked", errors: parsed.errors });
        }
        if (hostPreview === undefined || hostPreview.status !== "ready") {
          return toolText({ status: "error", errors: ["pack declared a ready preview without a successful host reconcile"] });
        }
        if (parsed.planHash !== hostPreview.planHash) {
          return toolText({
            status: "error",
            errors: [
              `plan hash mismatch: pack declared ${parsed.planHash} but the host reconciled ${hostPreview.planHash}`,
            ],
          });
        }
        pendingPlans.set(parsed.planHash, {
          sessionId: hostSessionId,
          candidate: parsed.candidate,
          preview: hostPreview,
          state: "previewed",
          indexState: "not-attempted",
        });
        return toolText({
          plan_hash: parsed.planHash,
          changes: parsed.changes,
          artifacts: [...parsed.artifacts].sort(),
        });
      } catch (error) {
        return toolText({ status: "error", errors: [String(error instanceof Error ? error.message : error)] });
      }
    },
  });

  // -----------------------------------------------------------------------
  // Explicit capture: engram_capture_apply
  // -----------------------------------------------------------------------
  api.registerTool({
    name: "engram_capture_apply",
    label: "Apply Engram capture",
    description: `Commit a previously previewed engram capture plan by its exact plan hash.
If the underlying records changed since the preview, the apply is refused as
stale and a fresh preview/approval round is required. After records commit,
the pack regenerates compatibility views; if that fails the commit stands and
a second apply with the same hash retries only view regeneration.`,
    parameters: {
      type: "object",
      properties: {
        plan_hash: { type: "string", minLength: 1 },
      },
      required: ["plan_hash"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (hostSessionId === undefined) {
          return toolText({ status: "error", errors: ["no active engram session; settle a turn first"] });
        }
        const planHash = params.plan_hash;
        if (typeof planHash !== "string" || planHash.length === 0) {
          return toolText({ status: "error", errors: ["plan_hash must be a non-empty string"] });
        }
        // Unknown or session-mismatched hashes are rejected without touching the CLI.
        const entry = pendingPlans.get(planHash);
        if (entry === undefined || entry.sessionId !== hostSessionId) {
          return toolText({
            plan_hash: planHash,
            status: "error",
            errors: ["unknown or session-mismatched plan_hash; run engram_capture_preview first"],
          });
        }
        const resolution = await resolveCaptureModule();
        if (resolution.kind !== "available") {
          return toolText({ plan_hash: planHash, status: "error", errors: ["binding-selected pack is unavailable"] });
        }

        if (entry.state === "previewed") {
          const outcome = await withTempCandidate(entry.candidate, (file) =>
            runCli(["knowledge", "approve", "--candidate", file, "--expect", planHash]));
          const parsed = parseCliApplyOutcome(outcome.stdout);
          if (parsed?.status === "stale_approval") {
            pendingPlans.delete(planHash);
            return toolText({ plan_hash: planHash, status: "stale", errors: [] });
          }
          if (parsed === undefined) {
            return toolText({
              plan_hash: planHash,
              status: "error",
              errors: [
                `engram knowledge approve failed (exit ${outcome.exitCode}): ${(outcome.stdout || outcome.stderr).slice(0, 500)}`,
              ],
            });
          }
          entry.appliedPlan = { planHash, mutations: parsed.mutations };
          entry.appliedAt ??= new Date().toISOString();
          entry.appliedStatus = parsed.status === "committed" ? "committed" : "no-change";
          entry.indexState = parsed.index;
          entry.state = "records-committed";
        }

        const appliedPlan = entry.appliedPlan;
        if (appliedPlan === undefined) {
          return toolText({ plan_hash: planHash, status: "error", errors: ["pending entry lost its applied plan"] });
        }
        const summary = summarizeMutations(appliedPlan.mutations);
        let materialization: MaterializationOutcome = { written: [], unchanged: [], stale: [] };
        let materializationFailed = false;
        if (resolution.materialize !== undefined) {
          try {
            materialization = normalizeMaterialization(
              await resolution.materialize(appliedPlan, materializeTools(entry)),
            );
          } catch (error) {
            materializationFailed = true;
            api.logger.warn(`[engram] materialization failed for plan ${planHash}: ${String(error)}`);
            materialization.stale.push({
              path: "(materialization)",
              reason: String(error instanceof Error ? error.message : error),
            });
          }
        }
        if (materializationFailed) {
          // Records stay committed; the entry is retained so a second apply
          // with the SAME hash reruns ONLY materialize, never knowledge approve.
          return toolText({
            plan_hash: planHash,
            status: "records-committed",
            index: entry.indexState,
            created: summary.created,
            retired: summary.retired,
            entity_keys: summary.entityKeys,
            artifacts: {
              generated: materialization.written.map((item) => item.path),
              unchanged: materialization.unchanged.map((item) => item.path),
              stale: materialization.stale,
            },
            retry: "apply the same plan_hash to retry materialization only",
          });
        }
        pendingPlans.delete(planHash);
        lastIndexState = entry.indexState;
        for (const staleItem of materialization.stale) sessionStaleArtifacts.push(staleItem.path);
        return toolText({
          plan_hash: planHash,
          status: entry.appliedStatus ?? "committed",
          index: entry.indexState,
          created: summary.created,
          retired: summary.retired,
          entity_keys: summary.entityKeys,
          artifacts: {
            generated: materialization.written.map((item) => item.path),
            unchanged: materialization.unchanged.map((item) => item.path),
            stale: materialization.stale,
          },
        });
      } catch (error) {
        return toolText({ status: "error", errors: [String(error instanceof Error ? error.message : error)] });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// TurnContext builder
// ---------------------------------------------------------------------------

function buildTurnContext(event: SessionStopEvent): TurnContext | undefined {
  const records = event.messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null && !Array.isArray(message),
  );
  if (records.length === 0) return undefined;

  // Ambient capture reads only what the user just said. Anchoring on the LAST
  // user message keeps `turnIndex` stable across repeat settlement of the same
  // turn, which is what makes ambient record IDs deterministic — the total
  // message count is not stable for that purpose.
  let latestUserMessage = -1;
  for (let index = 0; index < records.length; index += 1) {
    if (records[index]?.role === "user") latestUserMessage = index;
  }
  if (latestUserMessage === -1) return undefined;
  const messages = records.slice(latestUserMessage);
  const narrative = extractTextContent(records[latestUserMessage] ?? {});
  const session: HostSessionProvenance = { id: event.session_id, host: "omp" };
  const lastAssistant = typeof event.last_assistant_message === "object" &&
    event.last_assistant_message !== null &&
    !Array.isArray(event.last_assistant_message)
    ? event.last_assistant_message as Record<string, unknown>
    : undefined;
  const rawTimestamp = lastAssistant?.timestamp;
  const timestamp = typeof rawTimestamp === "number"
    ? new Date(rawTimestamp).toISOString()
    : typeof rawTimestamp === "string"
      ? rawTimestamp
      : new Date().toISOString();

  // Tool provenance from the latest user message onward is retained so the
  // pack can suppress ambient duplicates of an explicit capture applied in
  // this same turn.
  const toolCalls: TurnToolCall[] = [];
  for (const raw of messages) {
    const role = String(raw.role ?? "");
    const content = extractTextContent(raw);
    if (role === "assistant") {
      const toolCallsData = raw.tool_calls ?? raw.toolCalls;
      if (Array.isArray(toolCallsData)) {
        for (const tc of toolCallsData) {
          const tcr = tc as Record<string, unknown>;
          const toolName = String(tcr.name ?? (tcr.function as Record<string, unknown>)?.name ?? "unknown");
          const toolInput = tcr.input ?? (tcr.function as Record<string, unknown>)?.arguments ?? {};
          toolCalls.push({
            tool: toolName,
            input: typeof toolInput === "string" ? { raw: toolInput } : (toolInput as Record<string, unknown>),
            result: undefined,
          });
        }
      }
      if (content.length > 0) {
        toolCalls.push({ tool: "respond", input: { content: content.slice(0, 200) }, result: undefined });
      }
    } else if (role === "tool" || role === "tool_result") {
      const toolName = String(raw.name ?? raw.tool_name ?? "tool");
      const result = raw.content ?? raw.result;
      const pending = [...toolCalls].reverse().find((tc) => tc.tool === toolName && tc.result === undefined);
      if (pending) {
        pending.result = typeof result === "string" ? result.slice(0, 500) : result;
      } else {
        toolCalls.push({
          tool: toolName,
          input: {},
          result: typeof result === "string" ? result.slice(0, 500) : result,
        });
      }
    }
  }

  return {
    session,
    turnIndex: latestUserMessage,
    timestamp,
    narrative,
    toolCalls,
  };
}

function extractTextContent(msg: Record<string, unknown>): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block: Record<string, unknown>) => {
        if (block.type === "text" && typeof block.text === "string") return block.text;
        if (block.type === "text" && typeof block.content === "string") return block.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof msg.content === "object" && msg.content !== null) {
    const inner = msg.content as Record<string, unknown>;
    if (typeof inner.text === "string") return inner.text;
    if (typeof inner.content === "string") return inner.content;
  }
  return "";
}
