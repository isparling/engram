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
 * Two capture paths, both converging on the engram transaction pipeline:
 *
 *   Hook (agent_end):  receives raw turn transcript → builds TurnContext →
 *                      pipes to `engram capture-from-turn` → pack's
 *                      extractCandidates() → LLM extraction → submit
 *   Tool (engram_capture): agent provides structured kind/statement/topics →
 *                         builds KnowledgeEnvelopeInput → writes to temp
 *                         file → calls `engram knowledge submit` → direct
 *                         submission, no extraction
 *
 * The extension is deliberately thin: it normalizes Oh My Pi events and
 * shells out to the engram CLI for all pack operations. This avoids
 * import-resolution issues between Oh My Pi's extension runtime and
 * engram's separate module layout.
 *
 * @module
 */

import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostSessionProvenance, TurnContext, TurnToolCall } from "@isparling/engram-harness/knowledge-types";

// ---------------------------------------------------------------------------
// ExtensionAPI types — mirrors the real omp type from
// @oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts
// ---------------------------------------------------------------------------

export interface ExtensionAPI {
  on(event: "agent_end", handler: (event: AgentEndEvent, ctx: ExtensionContext) => void | Promise<void>): void;
  registerTool(tool: ToolDefinition): void;
  logger: { info: (message: string) => void; warn: (message: string) => void };
}

export interface AgentEndEvent {
  type: "agent_end";
  messages: unknown[];
  willContinue?: boolean;
  sessionId?: string;
  turnIndex?: number;
  timestamp?: string;
}

export interface ExtensionContext {
  sessionId: string;
  cwd: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
  handler: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
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


  // Session identifier — captured from the first agent_end event's ctx.
  // Before that, CLI calls will use "pending" which won't resolve a space;
  // the first agent_end event resolves it.
  let hostSessionId: string | undefined;

  /** Build env for CLI calls, including the session id resolveActiveSpace requires. */
  function cliEnv(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      ENGRAM_BINDING_REGISTRY: bindingRegistryPath,
      ENGRAM_HOST_SESSION_ID: hostSessionId ?? "pending",
    };
  }

  // Cached extraction pack id — resolved lazily once a real session id is known.
  let extractionPackId = "work-pack";
  let extractionPackVersion = "0.1.0";
  let extractionSpaceId = "current";
  let resolvedPackId = false;

  /** Resolve the extraction pack from the active space. Called once on first agent_end. */
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
      if (activeSpaces === undefined) return;
      const space = activeSpaces[hostSessionId];
      if (space === undefined) return;
      extractionSpaceId = String(space.space_id ?? "current");
      const packs = space.packs as Array<Record<string, unknown>> | undefined;
      if (packs === undefined) return;
      const extractPack = packs.find((p) => p.extract === true);
      if (extractPack === undefined) return;
      extractionPackId = String(extractPack.id);
      extractionPackVersion = String(extractPack.version);
      resolvedPackId = true;
    } catch {
      // Keep defaults
    }
  }


  // -----------------------------------------------------------------------
  // Structural capture: agent_end hook
  // -----------------------------------------------------------------------
  api.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    // Capture the real session id from the first event; resolves the
    // extraction pack lazily now that we can query the right space.
    hostSessionId = ctx.sessionId;
    await resolveExtractionPack();

    // Guard: skip auto-retry/continuation settles
    if (event.willContinue === true) return;
    if (!Array.isArray(event.messages) || event.messages.length === 0) return;

    const turn = buildTurnContext(event);
    if (turn === undefined) return;


    // CLI fallback path
    try {
      const proc = Bun.spawn([cliPath, "capture-from-turn"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: cliEnv(),
      });
      await proc.stdin.write(JSON.stringify(turn) + "\n");
      await proc.stdin.end();

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        api.logger.warn(`[engram] capture-from-turn failed (exit ${exitCode}): ${(stdout || stderr).slice(0, 500)}`);
      }
    } catch (err) {
      api.logger.warn(`[engram] failed to invoke engram CLI: ${err}`);
    }
  });

  // -----------------------------------------------------------------------
  // Status tool: report loaded pack and mode
  // -----------------------------------------------------------------------
  api.registerTool({
    name: "engram_status",
    description: "Report the binding-selected pack identity and CLI mode.",
    parameters: { type: "object", properties: {} },
    handler: async () => ({
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
    handler: async (params: Record<string, unknown>) => {
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
        if (exitCode === 0) return { status: "submitted", detail: stdout, id };
        return { status: "error", detail: (stdout || stderr).slice(0, 1000), id };
      } catch (error) {
        return { status: "error", detail: String(error).slice(0, 1000), id };
      } finally {
        if (candidateDir !== undefined) await rm(candidateDir, { recursive: true, force: true });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// TurnContext builder
// ---------------------------------------------------------------------------

function buildTurnContext(event: AgentEndEvent): TurnContext | undefined {
  const messages = event.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;

  const session: HostSessionProvenance = {
    id: String(event.sessionId ?? "unknown"),
    host: "omp",
  };

  const turnIndex = typeof event.turnIndex === "number" ? event.turnIndex : 0;
  const timestamp = event.timestamp ?? new Date().toISOString();

  const narrativeParts: string[] = [];
  const toolCalls: TurnToolCall[] = [];

  for (const raw of messages as Array<Record<string, unknown>>) {
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
    turnIndex,
    timestamp: String(timestamp ?? new Date().toISOString()),
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
