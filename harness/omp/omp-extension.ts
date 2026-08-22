/**
 * Oh My Pi extension for engram knowledge capture.
 *
 * Hooks into the agent lifecycle to extract structured knowledge candidates
 * from settled turns, and registers a voluntary `engram_capture` tool for
 * mid-turn capture.
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
 *   ENGRAM_CLI              (optional)  path to engram CLI binary (default: "engram")
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
 *   Tool (engram_capture): agent provides structured kind/statement/topics →
 *                          builds KnowledgeEnvelopeInput → writes to temp
 *                          file → calls `engram knowledge submit`.
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
import type { HostSessionProvenance, TurnContext, TurnToolCall } from "@isparling/engram-harness/knowledge-types";

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
  description: string;
  parameters: unknown;
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}
export type CaptureTools = {
  recordsRoot: string;
  spaceId: string;
  writeFile(path: string, content: string): Promise<void>;
  refreshIndex(): Promise<void>;
};

export type CaptureSummary = {
  created: string[];
  existing: string[];
  invalid: Array<{ id: string; errors: string[] }>;
};

export type CaptureHandler = (
  turn: TurnContext,
  tools: CaptureTools,
) => Promise<CaptureSummary>;
export type CaptureResolution =
  | { kind: "available"; handler: CaptureHandler }
  | { kind: "absent" }
  | { kind: "failed"; message: string };
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

export default async function engramExtension(api: ExtensionAPI): Promise<void> {
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

  function resetSessionResolution(): void {
    extractionPackId = "work-pack";
    extractionPackVersion = "0.1.0";
    extractionPackFrom = undefined;
    extractionSpaceId = "current";
    extractionRecordsRoot = "";
    captureResolution = undefined;
    resolvedPackId = false;
    lastCapturedTurnKey = undefined;
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

  async function resolveCaptureHandler(): Promise<CaptureResolution> {
    if (captureResolution !== undefined) return captureResolution;
    try {
      const specifier = await packModuleSpecifier();
      // Runtime-selected by the active binding; a static import cannot model
      // an external pack declaration.
      const module = await import(specifier) as Record<string, unknown>;
      const selected = packExport(module, extractionPackId);
      if (
        typeof selected !== "object" ||
        selected === null ||
        Array.isArray(selected) ||
        (selected as Record<string, unknown>).id !== extractionPackId ||
        (selected as Record<string, unknown>).version !== extractionPackVersion ||
        typeof (selected as Record<string, unknown>).extractCandidates !== "function"
      ) {
        captureResolution = { kind: "failed", message: "pack export identity or extractor surface does not match the active binding" };
      } else if (typeof module.captureFromTurn === "function") {
        captureResolution = { kind: "available", handler: module.captureFromTurn as CaptureHandler };
      } else {
        captureResolution = { kind: "absent" };
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
    };
  }


  // -----------------------------------------------------------------------
  // Structural capture: awaited final-settle hook
  // -----------------------------------------------------------------------
  api.on("session_stop", async (event: SessionStopEvent, _ctx: ExtensionContext) => {
    if (event.signal.aborted) return;
    if (event.session_id === "") {
      api.logger.warn("[engram] session_stop omitted a host session id");
      return;
    }
    if (hostSessionId !== event.session_id) resetSessionResolution();
    hostSessionId = event.session_id;
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
    const resolution = await resolveCaptureHandler();
    if (resolution.kind === "failed") {
      api.logger.warn(`[engram] failed to load pack capture handler: ${resolution.message}`);
      return;
    }
    if (resolution.kind === "available") {
      try {
        const summary = await resolution.handler(turn, await captureTools(event.signal));
        if (event.signal.aborted) return;
        api.logger.info(
          `[engram] capture: ${summary.created.length} draft(s), ` +
          `${summary.existing.length} existing, ${summary.invalid.length} invalid`,
        );
        lastCapturedTurnKey = turnKey;
      } catch (error) {
        if (!event.signal.aborted) api.logger.warn(`[engram] pack capture handler failed: ${String(error)}`);
      }
      return;
    }

    // A successfully loaded pack without a handler retains the generic CLI path.
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
  // Status tool: report loaded pack and mode
  // -----------------------------------------------------------------------
  api.registerTool({
    name: "engram_status",
    description: "Report the binding-selected pack identity and CLI mode.",
    parameters: { type: "object", properties: {} },
    execute: async () => toolText({
      pack_id: resolvedPackId ? extractionPackId : null,
      pack_version: resolvedPackId ? extractionPackVersion : null,
      mode: "cli",
    }),
  });

  // -----------------------------------------------------------------------
  // Voluntary capture: engram_capture tool
  // -----------------------------------------------------------------------
  api.registerTool({
    name: "engram_capture",
    description: `Submit a structured knowledge observation from the current session.
Use this to record decisions, outcomes, risks, or notable events mid-turn
rather than waiting for end-of-turn extraction. Bypasses the pack's
extraction pipeline — the agent provides the classification directly.

Parameters:
- kind: one of "evidence", "claim", "interpretation", "decision", "recommendation"
- statement: free-form description of the observation
- scope_topics: array of topic tags (e.g. ["work:decision", "work:architecture"])
- subjects: array of subject identifiers (optional)`,
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["evidence", "claim", "interpretation", "decision", "recommendation"] },
        statement: { type: "string", minLength: 1 },
        scope_topics: { type: "array", items: { type: "string" }, default: [] },
        subjects: { type: "array", items: { type: "string" }, default: [] },
      },
      required: ["kind", "statement"],
    },
    execute: async (params: Record<string, unknown>) => {
      const id = `capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const envelope = {
        id,
        kind: String(params.kind ?? "claim"),
        status: "candidate" as const,
        disposition: "new" as const,
        scope: {
          space: extractionSpaceId,
          subjects: Array.isArray(params.subjects) ? params.subjects.map(String) : [],
          topics: Array.isArray(params.scope_topics) ? params.scope_topics.map(String) : [],
          contexts: [] as string[],
          dimensions: {} as Record<string, string[]>,
        },
        pack: { id: extractionPackId, version: extractionPackVersion },
        sources: [{ type: "engram-capture-tool" as const, ref: `session:${registryPath}` }],
        session: { id: hostSessionId ?? "pending", host: "omp" as const },
        submittedAt: new Date().toISOString(),
        details: {} as Record<string, unknown>,
        statement: String(params.statement ?? ""),
      };


      const cliCandidate = toCliCandidate(envelope);
      let candidateDir: string | undefined;
      try {
        candidateDir = await mkdtemp(join(tmpdir(), "engram-candidate-"));
        await chmod(candidateDir, 0o700);
        const tmpFile = join(candidateDir, "candidate.json");
        const file = await open(tmpFile, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(cliCandidate), "utf8");
        } finally {
          await file.close();
        }
        const proc = Bun.spawn([cliPath, "knowledge", "submit", "--candidate", tmpFile], {
          stdout: "pipe",
          stderr: "pipe",
          env: cliEnv(),
        });
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        if (exitCode === 0) return toolText({ status: "submitted", detail: stdout, id });
        return toolText({ status: "error", detail: (stdout || stderr).slice(0, 1000), id });
      } catch (error) {
        return toolText({ status: "error", detail: String(error).slice(0, 1000), id });
      } finally {
        if (candidateDir !== undefined) await rm(candidateDir, { recursive: true, force: true });
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

  let firstCurrentMessage = 0;
  for (let index = 0; index < records.length; index += 1) {
    if (records[index]?.role === "user") firstCurrentMessage = index;
  }
  const messages = records.slice(firstCurrentMessage);
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

  const narrativeParts: string[] = [];
  const toolCalls: TurnToolCall[] = [];
  for (const raw of messages) {
    const role = String(raw.role ?? "");
    const content = extractTextContent(raw);
    if (role === "user") {
      narrativeParts.push(`User: ${content}`);
    } else if (role === "assistant") {
      narrativeParts.push(`Assistant: ${content}`);
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
      narrativeParts.push(`Tool ${toolName}: returned`);
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
    turnIndex: records.length,
    timestamp,
    narrative: narrativeParts.join("\n"),
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
