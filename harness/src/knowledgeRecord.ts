import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  validateKnowledgeEnvelope,
  validationError,
} from "./knowledgeValidation.ts";
import type {
  KnowledgeError,
  KnowledgeHistoryEntry,
  KnowledgeRecord,
  KnowledgeRelationships,
  KnowledgeResult,
  RelationshipKind,
} from "./knowledgeTypes.ts";

const FRONTMATTER_FIELDS = [
  "schema_version",
  "id",
  "kind",
  "status",
  "statement",
  "details",
  "scope",
  "pack",
  "sources",
  "session",
  "submitted_at",
  "disposition",
  "relationships",
  "history",
] as const;

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("cannot canonicalize an unsupported value");
}

export function hashKnowledgeText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string, field: string, errors: KnowledgeError[]): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch (error) {
    errors.push(validationError("record_invalid", `${field} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, field));
    return undefined;
  }
}

function parseFrontmatter(text: string): KnowledgeResult<{ values: Record<string, unknown>; body: string[] }> {
  const errors: KnowledgeError[] = [];
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines[0] !== "---") {
    return { ok: false, errors: [validationError("record_invalid", "record must begin with a frontmatter delimiter")] };
  }
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0) {
    return { ok: false, errors: [validationError("record_invalid", "record frontmatter is missing its closing delimiter")] };
  }
  const values: Record<string, unknown> = {};
  for (let index = 1; index < closingIndex; index++) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    const match = /^([a-z][a-z0-9_]*):\s*(.*)$/.exec(line);
    if (match === null) {
      errors.push(validationError("record_invalid", `unrecognized frontmatter line: ${JSON.stringify(line)}`));
      continue;
    }
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) {
      errors.push(validationError("record_invalid", `frontmatter line is incomplete: ${JSON.stringify(line)}`));
      continue;
    }
    if (!FRONTMATTER_FIELDS.some((field) => field === key)) {
      errors.push(validationError("unknown_field", `record has unknown frontmatter field ${key}`, key));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      errors.push(validationError("record_invalid", `record repeats frontmatter field ${key}`, key));
      continue;
    }
    values[key] = parseJson(rawValue, key, errors);
  }
  const body = lines.slice(closingIndex + 1);
  if (body.length > 0 && body[body.length - 1] === "") body.pop();
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { values, body } };
}

function relationshipValues(value: unknown, errors: KnowledgeError[]): KnowledgeRelationships | undefined {
  if (!isObject(value)) {
    errors.push(validationError("record_invalid", "relationships must be an object", "relationships"));
    return undefined;
  }
  const keys = ["supports", "contradicts", "refines", "supersedes"] as const;
  for (const key of Object.keys(value)) {
    if (!keys.some((allowed) => allowed === key)) errors.push(validationError("unknown_field", `relationships contains unknown field ${key}`, `relationships.${key}`));
  }
  let supports: string[] | undefined;
  let contradicts: string[] | undefined;
  let refines: string[] | undefined;
  let supersedes: string[] | undefined;
  for (const key of keys) {
    const raw = value[key];
    if (!Array.isArray(raw)) {
      errors.push(validationError("record_invalid", `relationships.${key} must be an array of record ids`, `relationships.${key}`));
      continue;
    }
    const parsed: string[] = [];
    let valid = true;
    for (const item of raw) {
      if (typeof item !== "string" || !/^[a-z][a-z0-9-]*$/.test(item)) valid = false;
      else parsed.push(item);
    }
    if (!valid) {
      errors.push(validationError("record_invalid", `relationships.${key} must be an array of record ids`, `relationships.${key}`));
      continue;
    }
    if (key === "supports") supports = parsed;
    else if (key === "contradicts") contradicts = parsed;
    else if (key === "refines") refines = parsed;
    else supersedes = parsed;
  }
  if (supports === undefined || contradicts === undefined || refines === undefined || supersedes === undefined) return undefined;
  return { supports, contradicts, refines, supersedes };
}

function historyValues(value: unknown, errors: KnowledgeError[]): KnowledgeHistoryEntry[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(validationError("record_invalid", "history must be an array", "history"));
    return undefined;
  }
  const result: KnowledgeHistoryEntry[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (!isObject(item)) {
      errors.push(validationError("record_invalid", `history[${index}] must be an object`, `history[${index}]`));
      continue;
    }
    const keys = Object.keys(item);
    for (const key of keys) {
      if (key !== "event" && key !== "related_id" && key !== "submitted_at") errors.push(validationError("unknown_field", `history[${index}] contains unknown field ${key}`, `history[${index}].${key}`));
    }
    if (typeof item.event !== "string" || item.event.length === 0 || /[\r\n]/.test(item.event)) errors.push(validationError("record_invalid", `history[${index}].event is invalid`, `history[${index}].event`));
    if (typeof item.related_id !== "string" || !/^[a-z][a-z0-9-]*$/.test(item.related_id)) errors.push(validationError("record_invalid", `history[${index}].related_id is invalid`, `history[${index}].related_id`));
    if (typeof item.submitted_at !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.submitted_at)) errors.push(validationError("record_invalid", `history[${index}].submitted_at is invalid`, `history[${index}].submitted_at`));
    if (typeof item.event === "string" && typeof item.related_id === "string" && typeof item.submitted_at === "string") {
      result.push({ event: item.event, relatedId: item.related_id, submittedAt: item.submitted_at });
    }
  }
  return result.length === value.length ? result : undefined;
}

export function parseKnowledgeRecord(text: string): KnowledgeResult<KnowledgeRecord> {
  const frontmatter = parseFrontmatter(text);
  if (!frontmatter.ok) return frontmatter;
  const errors: KnowledgeError[] = [];
  const values = frontmatter.value.values;
  for (const field of FRONTMATTER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(values, field)) errors.push(validationError("record_invalid", `record is missing frontmatter field ${field}`, field));
  }
  if (values.schema_version !== 0) errors.push(validationError("record_invalid", "record schema_version must be 0", "schema_version"));

  const envelopeInput = {
    id: values.id,
    kind: values.kind,
    status: values.status,
    statement: values.statement,
    details: values.details,
    scope: values.scope,
    pack: values.pack,
    sources: values.sources,
    session: values.session,
    submitted_at: values.submitted_at,
    disposition: values.disposition,
  };
  const envelope = validateKnowledgeEnvelope(envelopeInput);
  if (!envelope.ok) errors.push(...envelope.errors);
  const relationships = relationshipValues(values.relationships, errors);
  const history = historyValues(values.history, errors);
  const body = frontmatter.value.body;
  if (body.length !== 3 || body[0] !== "## Statement" || body[1] !== "" || body[2] !== values.statement) {
    errors.push(validationError("record_invalid", "record body must contain the authoritative statement under ## Statement", "body"));
  }
  if (errors.length > 0 || !envelope.ok || relationships === undefined || history === undefined) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: 0,
      ...envelope.value,
      relationships,
      history,
    },
  };
}

export function serializeKnowledgeRecord(record: KnowledgeRecord): string {
  const lines = [
    "---",
    "schema_version: 0",
    `id: ${canonicalJson(record.id)}`,
    `kind: ${canonicalJson(record.kind)}`,
    `status: ${canonicalJson(record.status)}`,
    `statement: ${canonicalJson(record.statement)}`,
    `details: ${canonicalJson(record.details)}`,
    `scope: ${canonicalJson(record.scope)}`,
    `pack: ${canonicalJson(record.pack)}`,
    `sources: ${canonicalJson(record.sources)}`,
    `session: ${canonicalJson(record.session)}`,
    `submitted_at: ${canonicalJson(record.submittedAt)}`,
    `disposition: ${canonicalJson(record.disposition)}`,
    `relationships: ${canonicalJson(record.relationships)}`,
    `history: ${canonicalJson(record.history.map((entry) => ({ event: entry.event, related_id: entry.relatedId, submitted_at: entry.submittedAt })))}`,
    "---",
    "## Statement",
    "",
    record.statement,
    "",
  ];
  return lines.join("\n");
}

export async function readKnowledgeRecord(path: string): Promise<KnowledgeResult<{ text: string; record: KnowledgeRecord }>> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = parseKnowledgeRecord(text);
    if (!parsed.ok) return parsed;
    return { ok: true, value: { text, record: parsed.value } };
  } catch (error) {
    return {
      ok: false,
      errors: [validationError("record_read_failed", `failed to read knowledge record: ${error instanceof Error ? error.message : String(error)}`, path)],
    };
  }
}

export function relationshipArray(record: KnowledgeRecord, kind: RelationshipKind): string[] {
  return record.relationships[kind];
}
