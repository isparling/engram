#!/usr/bin/env node
// CLI entry — schema_version 0 remains intentionally unstable.
//
// Usage:
//   engram submit --candidate <path-to-candidate.json>
//   engram submit --candidate <path-to-candidate.json> --approve --expect <hash>
//   engram knowledge submit|reconcile --candidate <path-to-candidate.json>
//   engram knowledge approve|reject --candidate <path-to-candidate.json> --expect <plan_hash>
//   engram rollup preview --bullets <path-to-batch.json>
//   engram rollup approve --bullets <path-to-batch.json> --expect <rollup-hash>
//   engram space register --binding <path-to-local-binding.json>
//   engram space select <space-id>
//   engram space status
//   engram recall --query <text> --audience <id>
//   engram version
//
// Knowledge operations resolve the selected space through ENGRAM_BINDING_REGISTRY
// and ENGRAM_HOST_SESSION_ID. There is deliberately no submit-time --space,
// --root, or --collection flag: a candidate cannot redirect its operation.
//
// --expect <hash> is mandatory alongside --approve: a non-additive
// candidate's approval_required result carries a `plan_hash` covering both
// the record as read and the bytes that would replace it, and re-approving
// must name that exact hash or the commit is refused as `stale_approval`
// (see submit.ts). This binds approval to the mutation the caller actually
// saw — not merely to the record it started from, which would let a
// different candidate be approved under an unchanged record's hash.
//
// Every result is printed to stdout as JSON carrying schema_version: 0.
// Exit codes: 0 = committed, 2 = approval_required, 3 = stale_approval,
// 1 = anything else (invalid candidate, invalid space binding, usage error).

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectSpaceRegistry,
  recordQmdFreshness,
  registerSpace,
  resolveActiveSpace,
  selectSpace,
  type ActiveSpace,
} from "./spaceRegistry.ts";
import { submitCandidate, type SubmitOutcome } from "./submit.ts";
import { REFRESH_NOT_ATTEMPTED } from "./qmdRunner.ts";
import { guardedRetrieve } from "./guardedRetrieval.ts";
import { renderPresentation } from "./presentation.ts";
import type { KnowledgePack, KnowledgeExtractor, PresentationPack, TurnContext, TurnToolCall, PackHelpers } from "./knowledgeTypes.ts";
import { loadExtractionPack, resolveKnowledgePack } from "./packLoader.ts";
import { requireDefined } from "./types.ts";
import {
  applyKnowledgeProposal,
  reconcileKnowledgeTransaction,
  submitKnowledgeCandidate,
  type ApplyKnowledgeOutcome,
} from "./knowledgeTransaction.ts";
import { approveKnowledgeRollup, previewKnowledgeRollup, type KnowledgeRollupApplyOutcome } from "./knowledgeRollup.ts";
import { readReleaseManifest } from "../../release/engram-release.ts";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const USAGE = [
  "usage: engram submit --candidate <path> [--approve --expect <hash>]",
  "       engram knowledge submit --candidate <path>",
  "       engram knowledge reconcile --candidate <path>",
  "       engram knowledge approve|reject --candidate <path> --expect <plan_hash>",
  "       engram rollup preview --bullets <path>",
  "       engram rollup approve --bullets <path> --expect <rollup-hash>",
  "       engram space register --binding <path>",
  "       engram space select <space-id>",
  "       engram space status",
  "       engram recall --query <text> --audience <id> [--source-class <class>]",
  "       engram render --view <id> --audience <id> --delivery <id> --model <provider/model> [--query <text>]",
].join("\n");

function usageError(message: string): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exit(1);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function printInvalid(errors: string[]): never {
  printJson({ schema_version: 0, status: "invalid", errors });
  process.exit(1);
}

/** Reads all of stdin as a string. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolves the one pack a space's manifest declares (`required_packs`,
 * surfaced as `ActiveSpace.packs`) into its implementation. Resolution is
 * explicit and external-only: the declared id/version are resolved through the
 * binding's `from` module specifier, and any resolution failure — a missing
 * `from`, an unloadable module, an invalid export, or an identity mismatch —
 * is reported to the caller and never substituted by another source. A space
 * declares exactly one pack; zero or several are refused here rather than
 * guessed at.
 */
async function resolveCliPack(active: ActiveSpace): Promise<KnowledgePack & PresentationPack> {
  if (active.packs.length !== 1) {
    printInvalid([
      active.packs.length === 0
        ? "active space declares no required packs; the CLI requires exactly one to resolve knowledge operations against"
        : `active space declares ${active.packs.length} required packs (${active.packs.map((pack) => pack.id).join(", ")}); the CLI will not guess which one to use`,
    ]);
  }
  const declared = requireDefined(active.packs[0], "active space packs[0] must exist once packs.length === 1");
  const resolved = await resolveKnowledgePack(declared.id, declared.version, declared.from, active.bindingPath);
  if (!resolved.ok) printInvalid(resolved.errors.map((error) => `${error.code}: ${error.message}`));
  return resolved.value;
}

function registryPath(): string {
  const value = process.env.ENGRAM_BINDING_REGISTRY;
  if (value === undefined || value.length === 0) printInvalid(["missing ENGRAM_BINDING_REGISTRY"]);
  if (!isAbsolute(value)) printInvalid(["ENGRAM_BINDING_REGISTRY must be an absolute path"]);
  return value;
}

function hostSessionId(): string {
  const value = process.env.ENGRAM_HOST_SESSION_ID;
  if (value === undefined || value.length === 0) printInvalid(["missing ENGRAM_HOST_SESSION_ID"]);
  return value;
}

async function runSpaceCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "register") {
    if (rest.length !== 2 || rest[0] !== "--binding") {
      usageError("space register requires exactly --binding <path>");
    }
    const bindingPath = rest[1];
    if (bindingPath === undefined) usageError("--binding requires a path");
    const result = await registerSpace(registryPath(), bindingPath);
    if (!result.ok) printInvalid(result.errors);
    printJson({ schema_version: 0, status: "registered", space: result.value });
    return;
  }
  if (subcommand === "select") {
    if (rest.length !== 1) usageError("space select requires exactly one space id");
    const spaceId = rest[0];
    if (spaceId === undefined) usageError("space select requires a space id");
    const result = await selectSpace(registryPath(), spaceId, hostSessionId());
    if (!result.ok) printInvalid(result.errors);
    printJson({ schema_version: 0, status: "selected", space: result.value });
    return;
  }
  if (subcommand === "status") {
    if (rest.length !== 0) usageError("space status accepts no arguments");
    const result = await inspectSpaceRegistry(registryPath());
    if (!result.ok) printInvalid(result.errors);
    printJson(result.value);
    return;
  }
  usageError(`unknown space command: ${subcommand ?? "(none)"}`);
}

async function runSubmitCommand(rest: string[]): Promise<void> {
  let candidatePath: string | undefined;
  let approve = false;
  let expectHash: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--approve") {
      approve = true;
    } else if (arg === "--candidate") {
      i++;
      candidatePath = rest[i];
      if (candidatePath === undefined) {
        usageError("--candidate requires a path argument");
      }
    } else if (arg === "--expect") {
      i++;
      expectHash = rest[i];
      if (expectHash === undefined) {
        usageError("--expect requires a hash argument");
      }
    } else {
      usageError(`unrecognized argument: ${arg}`);
    }
  }

  if (!candidatePath) {
    usageError("missing required --candidate <path>");
  }

  if (approve && expectHash === undefined) {
    usageError("--approve requires --expect <hash> (the plan_hash from a prior approval_required result)");
  }

  const bindingResult = await resolveActiveSpace(process.env);
  if (!bindingResult.ok) {
    printJson({
      schema_version: 0,
      status: "invalid",
      errors: bindingResult.errors,
      refresh: REFRESH_NOT_ATTEMPTED,
    });
    process.exit(1);
  }

  let candidateInput: unknown;
  try {
    const raw = await readFile(candidatePath, "utf8");
    candidateInput = JSON.parse(raw);
  } catch (error) {
    printJson({
      schema_version: 0,
      status: "invalid",
      errors: [`failed to read/parse candidate file: ${error instanceof Error ? error.message : String(error)}`],
      refresh: REFRESH_NOT_ATTEMPTED,
    });
    process.exit(1);
  }

  const result: SubmitOutcome = await submitCandidate({
    binding: bindingResult.value,
    candidateInput,
    approve,
    ...(expectHash === undefined ? {} : { expectHash }),
    submittedAt: todayIsoDate(),
  });

  let output: unknown = result;
  if (result.status === "committed") {
    const registry = process.env.ENGRAM_BINDING_REGISTRY;
    if (registry !== undefined) {
      const recorded = await recordQmdFreshness(registry, bindingResult.value.spaceId, result.refresh.state);
      if (!recorded.ok) output = { ...result, status_warnings: recorded.errors };
    }
  }

  printJson(output);

  if (result.status === "committed") process.exit(0);
  if (result.status === "approval_required") process.exit(2);
  if (result.status === "stale_approval") process.exit(3);
  process.exit(1);
}

async function readCandidateFile(candidatePath: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await readFile(candidatePath, "utf8"));
    return parsed;
  } catch (error) {
    printInvalid([`failed to read/parse candidate file: ${error instanceof Error ? error.message : String(error)}`]);
  }
}

function knowledgeArgs(rest: string[]): { candidatePath: string; expectHash?: string } {
  let candidatePath: string | undefined;
  let expectHash: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--candidate") {
      index++;
      candidatePath = rest[index];
      if (candidatePath === undefined) usageError("--candidate requires a path argument");
    } else if (arg === "--expect") {
      index++;
      expectHash = rest[index];
      if (expectHash === undefined) usageError("--expect requires a plan hash argument");
    } else {
      usageError(`unrecognized argument: ${arg}`);
    }
  }
  if (candidatePath === undefined) usageError("missing required --candidate <path>");
  return { candidatePath, ...(expectHash === undefined ? {} : { expectHash }) };
}

function knowledgeExit(outcome: ApplyKnowledgeOutcome): never {
  if (outcome.status === "committed" || outcome.status === "rejected" || outcome.status === "no_change") process.exit(0);
  if (outcome.status === "stale_approval") process.exit(3);
  if (outcome.status === "approval_required") process.exit(2);
  process.exit(1);
}

async function runKnowledgeCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "submit" && subcommand !== "reconcile" && subcommand !== "approve" && subcommand !== "reject") {
    usageError(`unknown knowledge command: ${subcommand ?? "(none)"}`);
  }
  const parsedArgs = knowledgeArgs(rest);
  const bindingResult = await resolveActiveSpace(process.env);
  if (!bindingResult.ok) {
    printJson({ schema_version: 0, status: "invalid", errors: bindingResult.errors, refresh: REFRESH_NOT_ATTEMPTED });
    process.exit(1);
  }
  const pack = await resolveCliPack(bindingResult.value);
  const candidateInput = await readCandidateFile(parsedArgs.candidatePath);

  if (subcommand === "submit") {
    const result = submitKnowledgeCandidate({ binding: bindingResult.value, candidateInput, pack });
    printJson(result);
    if (result.status === "submitted") process.exit(0);
    process.exit(1);
  }

  const proposalResult = await reconcileKnowledgeTransaction({
    binding: bindingResult.value,
    candidateInput,
    pack,
  });
  if (subcommand === "reconcile") {
    printJson(proposalResult);
    if (proposalResult.status === "proposal") process.exit(0);
    process.exit(1);
  }
  if (proposalResult.status !== "proposal") {
    printJson(proposalResult);
    process.exit(1);
  }
  if (parsedArgs.expectHash === undefined) {
    printJson({ schema_version: 0, status: "invalid", errors: ["knowledge approval requires --expect <plan_hash> from a prior reconcile"] });
    process.exit(1);
  }
  const applied = await applyKnowledgeProposal({
    binding: bindingResult.value,
    proposal: proposalResult.proposal,
    decision: subcommand === "approve" ? "approve" : "reject",
    expectedPlanHash: parsedArgs.expectHash,
    pack,
  });
  let output: unknown = applied;
  if (applied.status === "committed") {
    const registry = process.env.ENGRAM_BINDING_REGISTRY;
    if (registry !== undefined) {
      const recorded = await recordQmdFreshness(registry, bindingResult.value.spaceId, applied.refresh.state);
      if (!recorded.ok) output = { ...applied, status_warnings: recorded.errors };
    }
  }
  printJson(output);
  knowledgeExit(applied);
}

function rollupArgs(rest: string[]): { bulletsPath: string; expectHash?: string } {
  let bulletsPath: string | undefined;
  let expectHash: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--bullets") {
      index++;
      bulletsPath = rest[index];
      if (bulletsPath === undefined) printInvalid(["--bullets requires a path argument"]);
    } else if (arg === "--expect") {
      index++;
      expectHash = rest[index];
      if (expectHash === undefined) printInvalid(["--expect requires a hash argument"]);
    } else {
      printInvalid([`unrecognized argument: ${arg}`]);
    }
  }
  if (bulletsPath === undefined) printInvalid(["missing required --bullets <path>"]);
  return { bulletsPath, ...(expectHash === undefined ? {} : { expectHash }) };
}

async function readBulletsFile(bulletsPath: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(bulletsPath, "utf8");
  } catch {
    printInvalid(["bullets file could not be read"]);
  }
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed;
  } catch {
    printInvalid(["bullets file content is not valid JSON"]);
  }
}

function rollupExit(outcome: KnowledgeRollupApplyOutcome): never {
  if (outcome.status === "committed" || outcome.status === "no_change") process.exit(0);
  if (outcome.status === "stale_approval") process.exit(3);
  process.exit(1);
}

async function runRollupCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "preview" && subcommand !== "approve") {
    printInvalid([`unknown rollup command: ${subcommand ?? "(none)"}`]);
  }
  const parsedArgs = rollupArgs(rest);
  if (subcommand === "preview" && parsedArgs.expectHash !== undefined) {
    printInvalid(["rollup preview does not accept --expect (only rollup approve does)"]);
  }
  if (subcommand === "approve" && parsedArgs.expectHash === undefined) {
    printInvalid(["rollup approve requires --expect <rollup-hash> (the rollup_hash from a prior rollup preview)"]);
  }

  const bindingResult = await resolveActiveSpace(process.env);
  if (!bindingResult.ok) printInvalid(bindingResult.errors);
  const pack = await resolveCliPack(bindingResult.value);
  const batchInput = await readBulletsFile(parsedArgs.bulletsPath);

  if (subcommand === "preview") {
    const result = await previewKnowledgeRollup({ binding: bindingResult.value, batchInput, pack });
    printJson(result);
    process.exit(result.status === "preview" ? 0 : 1);
  }

  const expectedRollupHash = requireDefined(parsedArgs.expectHash, "rollup approve expectHash validated above");
  const applied = await approveKnowledgeRollup({
    binding: bindingResult.value,
    batchInput,
    expectedRollupHash,
    pack,
  });

  let output: unknown = applied;
  if (applied.status === "committed" || applied.status === "no_change" || applied.status === "stopped") {
    const registry = process.env.ENGRAM_BINDING_REGISTRY;
    if (registry !== undefined) {
      const warnings: string[] = [];
      const committedItems = applied.status === "stopped" ? applied.committed_items : applied.items;
      for (const item of committedItems) {
        if (item.refresh.state === "not-attempted") continue;
        const recorded = await recordQmdFreshness(registry, bindingResult.value.spaceId, item.refresh.state);
        if (!recorded.ok) warnings.push(...recorded.errors);
      }
      if (warnings.length > 0) output = { ...applied, status_warnings: warnings };
    }
  }
  printJson(output);
  rollupExit(applied);
}

function parseRecallArgs(args: string[]): { query: string; audienceId: string; requestedSourceClasses: string[] } {
  let query: string | undefined;
  let audienceId: string | undefined;
  const requestedSourceClasses: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--query") {
      index++;
      query = args[index];
      if (query === undefined) usageError("--query requires a value");
    } else if (arg === "--audience") {
      index++;
      audienceId = args[index];
      if (audienceId === undefined) usageError("--audience requires a value");
    } else if (arg === "--source-class") {
      index++;
      const sourceClass = args[index];
      if (sourceClass === undefined) usageError("--source-class requires a value");
      requestedSourceClasses.push(sourceClass);
    } else {
      usageError(`unrecognized argument: ${arg}`);
    }
  }
  if (query === undefined) usageError("recall requires --query <text>");
  if (audienceId === undefined) usageError("recall requires --audience <id>");
  return { query, audienceId, requestedSourceClasses };
}

async function runRecallCommand(args: string[]): Promise<void> {
  const parsed = parseRecallArgs(args);
  // No pack fallback. If the space cannot be resolved there is no declared
  // pack, and substituting one would run a query under rules the space never
  // asked for. guardedRetrieve would fail on the same unresolved space anyway,
  // so failing here costs nothing and removes a silent substitution.
  const bindingResult = await resolveActiveSpace(process.env);
  if (!bindingResult.ok) printInvalid(bindingResult.errors);
  const pack = await resolveCliPack(bindingResult.value);
  const result = await guardedRetrieve({
    query: parsed.query,
    audienceId: parsed.audienceId,
    ...(parsed.requestedSourceClasses.length === 0 ? {} : { requestedSourceClasses: parsed.requestedSourceClasses }),
    pack,
  });
  printJson(result);
  if (result.status === "failed") process.exit(1);
  process.exit(0);
}

function parseRenderArgs(args: string[]): {
  viewId: string;
  audienceId: string;
  deliveryId: string;
  model: string;
  query?: string;
  generatedAt?: string;
} {
  let viewId: string | undefined;
  let audienceId: string | undefined;
  let deliveryId: string | undefined;
  let model: string | undefined;
  let query: string | undefined;
  let generatedAt: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--view") {
      index++;
      viewId = args[index];
      if (viewId === undefined) usageError("--view requires a value");
    } else if (arg === "--audience") {
      index++;
      audienceId = args[index];
      if (audienceId === undefined) usageError("--audience requires a value");
    } else if (arg === "--delivery") {
      index++;
      deliveryId = args[index];
      if (deliveryId === undefined) usageError("--delivery requires a value");
    } else if (arg === "--model") {
      index++;
      model = args[index];
      if (model === undefined) usageError("--model requires a value");
    } else if (arg === "--query") {
      index++;
      query = args[index];
      if (query === undefined) usageError("--query requires a value");
    } else if (arg === "--generated-at") {
      index++;
      generatedAt = args[index];
      if (generatedAt === undefined) usageError("--generated-at requires a value");
    } else {
      usageError(`unrecognized argument: ${arg}`);
    }
  }
  if (viewId === undefined) usageError("render requires --view <id>");
  if (audienceId === undefined) usageError("render requires --audience <id>");
  if (deliveryId === undefined) usageError("render requires --delivery <id>");
  if (model === undefined) usageError("render requires --model <provider/model>");
  return {
    viewId,
    audienceId,
    deliveryId,
    model,
    ...(query === undefined ? {} : { query }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
  };
}

async function runRenderCommand(args: string[]): Promise<void> {
  const parsed = parseRenderArgs(args);
  const bindingResult = await resolveActiveSpace(process.env);
  if (!bindingResult.ok) printInvalid(bindingResult.errors);
  const pack = await resolveCliPack(bindingResult.value);
  const result = await renderPresentation({ ...parsed, pack });
  printJson(result);
  if (result.status === "failed") process.exit(1);
  process.exit(0);
}

async function runCaptureFromTurnCommand(args: string[]): Promise<void> {
  // Read TurnContext from stdin
  const stdin = await readStdin();
  if (stdin.length === 0) {
    printJson({ schema_version: 0, status: "invalid", errors: ["expected TurnContext JSON on stdin"] });
    process.exit(1);
  }

  let turnInput: unknown;
  try {
    turnInput = JSON.parse(stdin);
  } catch {
    printJson({ schema_version: 0, status: "invalid", errors: ["stdin must be valid JSON"] });
    process.exit(1);
  }

  const bindingResult = await resolveActiveSpace(process.env);
  if (!bindingResult.ok) {
    printJson({ schema_version: 0, status: "invalid", errors: bindingResult.errors, refresh: REFRESH_NOT_ATTEMPTED });
    process.exit(1);
  }
  const binding = bindingResult.value;

  // Find the designated extraction pack from the active space
  const extractionPack = binding.packs.find((p) => p.extract === true);
  if (extractionPack === undefined) {
    printJson({ schema_version: 0, status: "invalid", errors: ["no extraction pack configured (no pack with extract: true)"] });
    process.exit(1);
  }

  // Load the KnowledgeExtractor via the pack loader
  const extractor = await loadExtractionPack(extractionPack.id, extractionPack.version, extractionPack.from, binding.bindingPath);
  if (!extractor.ok) {
    printJson({
      schema_version: 0,
      status: "invalid",
      errors: extractor.errors.map((error) => `${error.code}: ${error.message}`),
    });
    process.exit(1);
  }

  // Build TurnContext from stdin
  const raw = turnInput as Record<string, unknown>;
  const turn: TurnContext = {
    session: { id: String((raw.session as Record<string, unknown>)?.id ?? "unknown"), host: "engram-cli" },
    turnIndex: typeof raw.turnIndex === "number" ? raw.turnIndex : 0,
    timestamp: String(raw.timestamp ?? new Date().toISOString()),
    narrative: String(raw.narrative ?? ""),
    toolCalls: Array.isArray(raw.toolCalls) ? raw.toolCalls as TurnToolCall[] : [],
  };

  const helpers: PackHelpers = {};
  const candidates = await extractor.value.extractCandidates(turn, helpers);

  if (candidates.length === 0) {
    printJson({ schema_version: 0, status: "no_candidates" });
    process.exit(0);
  }

  // Submit each candidate through the knowledge transaction pipeline
  const results: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    const packRef = (candidate as Record<string, unknown>).pack as { id: string; version: string } | undefined;
    if (packRef === undefined) {
      results.push({ id: "(unknown)", status: "invalid", errors: ["candidate missing pack reference"] });
      continue;
    }

    // Resolve the KnowledgePack for validation through the binding's `from`
    // module specifier alone. The external interface is documented in
    // harness/docs/pack-interface.md. There is no bundled fallback.
    const fromPack = binding.packs.find((p) => p.id === packRef.id);
    const packResult = await resolveKnowledgePack(packRef.id, packRef.version, fromPack?.from, binding.bindingPath);
    if (!packResult.ok) {
      results.push({ id: packRef.id, status: "invalid", errors: packResult.errors.map((error) => `${error.code}: ${error.message}`) });
      continue;
    }

    const outcome = submitKnowledgeCandidate({ binding, candidateInput: candidate, pack: packResult.value });
    results.push({ id: packRef.id, ...outcome });
  }

  printJson({ schema_version: 0, status: "complete", results });
  const hasErrors = results.some((r) => r.status === "invalid");
  process.exit(hasErrors ? 1 : 0);
}

async function runVersionCommand(): Promise<void> {
  const packageManifestPath = fileURLToPath(new URL("../release-manifest.json", import.meta.url));
  const releaseManifestPath = fileURLToPath(new URL("../../release-manifest.json", import.meta.url));
  let manifest = await readReleaseManifest(packageManifestPath);
  if (!manifest.ok) manifest = await readReleaseManifest(releaseManifestPath);
  if (!manifest.ok) {
    printJson({
      schema_version: 0,
      status: "invalid",
      errors: [{ code: "release_manifest_invalid", message: "installed release manifest is unavailable or invalid" }],
    });
    process.exit(1);
  }
  printJson({
    schema_version: 0,
    status: "version",
    release_id: manifest.value.version,
    source_revision: manifest.value.source_revision,
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "space") {
    await runSpaceCommand(rest);
    return;
  }
  if (command === "submit") {
    await runSubmitCommand(rest);
    return;
  }
  if (command === "knowledge") {
    await runKnowledgeCommand(rest);
    return;
  }
  if (command === "rollup") {
    await runRollupCommand(rest);
    return;
  }
  if (command === "recall") {
    await runRecallCommand(rest);
    return;
  }
  if (command === "render") {
    await runRenderCommand(rest);
    return;
  }
  if (command === "capture-from-turn") {
    await runCaptureFromTurnCommand(rest);
    return;
  }
  if (command === "version") {
    await runVersionCommand();
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  usageError(`unknown command: ${command ?? "(none)"}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
