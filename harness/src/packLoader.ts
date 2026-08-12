/**
 * Pack loader — resolves a pack's declared `from` module specifier to a
 * KnowledgeExtractor or KnowledgePack implementation. Resolution is explicit
 * and external-only: the loader imports exactly the module the binding named
 * and enforces that the selected export's declared id and version match the
 * binding request. There is no bundled registry to fall back to and no silent
 * substitution.
 *
 * The loader does NOT own pack validation, reconciliation, or the transaction
 * pipeline. It is the one bridge between the binding's declared pack identity
 * and a loadable module.
 *
 * Error contract: every failure is `kind: "validation"` and uses exactly
 * `pack_from_required`, `pack_load_failed`, `pack_export_invalid`, or
 * `pack_identity_mismatch`. Messages describe the category and never print
 * module contents, local paths, or an imported exception stack.
 *
 * @module
 */

import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { KnowledgeExtractor, KnowledgePack, KnowledgeResult, PresentationPack } from "./knowledgeTypes.ts";

function packError<T>(code: string, message: string): KnowledgeResult<T> {
  return { ok: false, errors: [{ kind: "validation", code, message }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function camelToSnake(name: string): string {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Locates a candidate export by the requested pack id. Checks, in order:
 *   1. A named export matching the pack id.
 *   2. A `default` export.
 *   3. An export in a `packs` or `packRegistry` object.
 */
function findExport(mod: Record<string, unknown>, id: string): unknown {
  const named = mod[id] ?? mod[camelToSnake(id)];
  if (named !== undefined) return named;

  const defaultExport = mod.default;
  if (defaultExport !== undefined) return defaultExport;

  const registry = mod.packs ?? mod.packRegistry;
  if (isRecord(registry)) {
    const entry = registry[id];
    if (entry !== undefined) return entry;
  }

  return undefined;
}

function isSourceClassPolicy(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.allowedSourceClasses) &&
    value.allowedSourceClasses.every((sourceClass) => typeof sourceClass === "string") &&
    typeof value.queryStrategy === "function" &&
    typeof value.classifySource === "function" &&
    (typeof value.relevanceThreshold === "number" || value.relevanceThreshold === null) &&
    typeof value.isEligible === "function" &&
    value.includePresentations === false
  );
}

function isView(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.version === "number" &&
    (value.scope === "search" || value.scope === "space") &&
    typeof value.retrievalQuery === "function" && typeof value.project === "function";
}

function isAudience(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.version === "number" &&
    typeof value.authorize === "function" && typeof value.adapt === "function";
}

function isDelivery(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.version === "number" &&
    (value.format === "markdown" || value.format === "plain" || value.format === "json") &&
    typeof value.maxWords === "number" && typeof value.retain === "boolean";
}

function isKnowledgePack(value: unknown): value is KnowledgePack & PresentationPack & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.version === "string" &&
    typeof value.validateEnvelope === "function" &&
    typeof value.relatedQuery === "function" &&
    typeof value.reconcile === "function" &&
    isSourceClassPolicy(value.retrievalPolicy) &&
    Array.isArray(value.views) && value.views.every(isView) &&
    Array.isArray(value.audiences) && value.audiences.every(isAudience) &&
    Array.isArray(value.deliveries) && value.deliveries.every(isDelivery)
  );
}

function isKnowledgeExtractor(value: unknown): value is KnowledgeExtractor & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.version === "string" &&
    typeof value.extractCandidates === "function"
  );
}

function moduleSpecifier(from: string, bindingPath: string | undefined): string {
  if (bindingPath !== undefined && (from.startsWith("./") || from.startsWith("../"))) {
    return pathToFileURL(resolve(dirname(bindingPath), from)).href;
  }
  return from;
}

/**
 * Resolves a pack `id`+`version` to its implementation, importing exactly the
 * binding's `from` module specifier and enforcing that the selected export's
 * declared identity matches. Refuses:
 *   - A missing or whitespace-only `from` as `pack_from_required`.
 *   - An unloadable module as `pack_load_failed`.
 *   - A module whose candidate export is not a complete KnowledgePack and
 *     PresentationPack as `pack_export_invalid`.
 *   - A valid-shaped export whose id or version differs as
 *     `pack_identity_mismatch`.
 */
export async function resolveKnowledgePack(
  id: string,
  version: string,
  from: string | undefined,
  bindingPath?: string,
): Promise<KnowledgeResult<KnowledgePack & PresentationPack>> {
  if (from === undefined || from.trim().length === 0) {
    return packError("pack_from_required", "a from module specifier is required to resolve the external pack");
  }

  let mod: Record<string, unknown>;
  try {
    mod = await import(moduleSpecifier(from, bindingPath));
  } catch {
    return packError("pack_load_failed", "the external pack module could not be loaded");
  }

  const candidate = findExport(mod, id);
  if (!isKnowledgePack(candidate)) {
    return packError("pack_export_invalid", "the external pack module does not export a complete KnowledgePack and PresentationPack");
  }
  if (candidate.id !== id || candidate.version !== version) {
    return packError("pack_identity_mismatch", "the external pack module's id or version does not match the declared pack");
  }
  return { ok: true, value: candidate };
}

/**
 * Loads a KnowledgeExtractor for the pack `id`+`version` declared with `from`,
 * with the same from, load, export, and identity checks as
 * `resolveKnowledgePack`.
 */
export async function loadExtractionPack(
  id: string,
  version: string,
  from: string | undefined,
  bindingPath?: string,
): Promise<KnowledgeResult<KnowledgeExtractor>> {
  if (from === undefined || from.trim().length === 0) {
    return packError("pack_from_required", "a from module specifier is required to load the extraction pack");
  }

  let mod: Record<string, unknown>;
  try {
    mod = await import(moduleSpecifier(from, bindingPath));
  } catch {
    return packError("pack_load_failed", "the extraction pack module could not be loaded");
  }

  const candidate = findExport(mod, id);
  if (!isKnowledgeExtractor(candidate)) {
    return packError("pack_export_invalid", "the extraction pack module does not export a complete KnowledgeExtractor");
  }
  if (candidate.id !== id || candidate.version !== version) {
    return packError("pack_identity_mismatch", "the extraction pack module's id or version does not match the declared extractor");
  }
  return { ok: true, value: candidate };
}