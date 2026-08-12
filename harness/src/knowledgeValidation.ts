import {
  KNOWLEDGE_DISPOSITIONS,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_STATUSES,
  type HostSessionProvenance,
  type JsonObject,
  type JsonValue,
  type KnowledgeDisposition,
  type KnowledgeEnvelope,
  type KnowledgeError,
  type KnowledgePackRef,
  type KnowledgeResult,
  type KnowledgeScope,
  type KnowledgeSource,
} from "./knowledgeTypes.ts";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(code: string, message: string, field?: string): KnowledgeError {
  return field === undefined
    ? { kind: "validation", code, message }
    : { kind: "validation", code, field, message };
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  if (!isObject(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item));
}

function findNewline(value: JsonValue, field: string, errors: KnowledgeError[]): void {
  if (typeof value === "string") {
    if (/[\r\n]/.test(value)) errors.push(error("newline_forbidden", `${field} must not contain newlines`, field));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findNewline(item, `${field}[${index}]`, errors));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) findNewline(item, `${field}.${key}`, errors);
  }
}

function nonEmptySingleLine(value: unknown, field: string, errors: KnowledgeError[], pattern?: RegExp): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(error("field_invalid", `${field} must be a non-empty string`, field));
    return undefined;
  }
  if (/[\r\n]/.test(value)) {
    errors.push(error("newline_forbidden", `${field} must not contain newlines`, field));
    return undefined;
  }
  if (pattern !== undefined && !pattern.test(value)) {
    errors.push(error("field_invalid", `${field} has an invalid structure`, field));
    return undefined;
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string, errors: KnowledgeError[], code: string): T | undefined {
  if (typeof value !== "string") {
    errors.push(error(code, `${field} must be one of ${allowed.join(", ")}`, field));
    return undefined;
  }
  const selected = allowed.find((item) => item === value);
  if (selected === undefined) {
    errors.push(error(code, `${field} must be one of ${allowed.join(", ")}`, field));
    return undefined;
  }
  return selected;
}

function stringArray(value: unknown, field: string, errors: KnowledgeError[]): string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(error("array_invalid", `${field} must be an array of strings`, field));
    return undefined;
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const parsed = nonEmptySingleLine(value[index], `${field}[${index}]`, errors);
    if (parsed !== undefined) result.push(parsed);
  }
  return result.length === value.length ? result : undefined;
}

function parsePackRef(value: unknown, field: string, errors: KnowledgeError[]): KnowledgePackRef | undefined {
  if (!isObject(value)) {
    errors.push(error("pack_invalid", `${field} must be an object`, field));
    return undefined;
  }
  for (const key of unknownKeys(value, ["id", "version"])) {
    errors.push(error("unknown_field", `${field} contains unknown field ${key}`, `${field}.${key}`));
  }
  const id = nonEmptySingleLine(value.id, `${field}.id`, errors, ID_PATTERN);
  const version = nonEmptySingleLine(value.version, `${field}.version`, errors);
  return id !== undefined && version !== undefined ? { id, version } : undefined;
}

function parseScope(value: unknown, errors: KnowledgeError[]): KnowledgeScope | undefined {
  if (!isObject(value)) {
    errors.push(error("scope_invalid", "scope must be an object", "scope"));
    return undefined;
  }
  for (const key of unknownKeys(value, ["space", "subjects", "topics", "contexts", "dimensions"])) {
    errors.push(error("unknown_field", `scope contains unknown field ${key}`, `scope.${key}`));
  }
  const space = nonEmptySingleLine(value.space, "scope.space", errors, ID_PATTERN);
  const subjects = stringArray(value.subjects, "scope.subjects", errors);
  const topics = stringArray(value.topics, "scope.topics", errors);
  const contexts = stringArray(value.contexts, "scope.contexts", errors);
  const dimensions: Record<string, string[]> = {};
  if (!isObject(value.dimensions)) {
    errors.push(error("scope_invalid", "scope.dimensions must be an object of string arrays", "scope.dimensions"));
  } else {
    for (const [key, raw] of Object.entries(value.dimensions)) {
      if (!ID_PATTERN.test(key)) {
        errors.push(error("scope_invalid", `scope.dimensions key ${key} is not a safe identifier`, `scope.dimensions.${key}`));
        continue;
      }
      const parsed = stringArray(raw, `scope.dimensions.${key}`, errors);
      if (parsed !== undefined) dimensions[key] = parsed;
    }
  }
  if (space === undefined || subjects === undefined || topics === undefined || contexts === undefined) return undefined;
  return { space, subjects, topics, contexts, dimensions };
}

function parseSources(value: unknown, errors: KnowledgeError[]): KnowledgeSource[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(error("sources_invalid", "sources must be a non-empty array", "sources"));
    return undefined;
  }
  const sources: KnowledgeSource[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!isObject(raw)) {
      errors.push(error("sources_invalid", `sources[${index}] must be an object`, `sources[${index}]`));
      continue;
    }
    for (const key of unknownKeys(raw, ["type", "ref"])) {
      errors.push(error("unknown_field", `sources[${index}] contains unknown field ${key}`, `sources[${index}].${key}`));
    }
    const type = nonEmptySingleLine(raw.type, `sources[${index}].type`, errors);
    const ref = nonEmptySingleLine(raw.ref, `sources[${index}].ref`, errors);
    if (type !== undefined && ref !== undefined) sources.push({ type, ref });
  }
  return sources.length === value.length ? sources : undefined;
}

function parseSession(value: unknown, errors: KnowledgeError[]): HostSessionProvenance | undefined {
  if (!isObject(value)) {
    errors.push(error("session_invalid", "session must be an object", "session"));
    return undefined;
  }
  for (const key of unknownKeys(value, ["id", "host"])) {
    errors.push(error("unknown_field", `session contains unknown field ${key}`, `session.${key}`));
  }
  const before = errors.length;
  const id = nonEmptySingleLine(value.id, "session.id", errors, SESSION_ID_PATTERN);
  const host = nonEmptySingleLine(value.host, "session.host", errors, ID_PATTERN);
  for (let index = before; index < errors.length; index++) {
    const current = errors[index];
    if (current !== undefined && current.field?.startsWith("session.")) errors[index] = { ...current, code: "session_invalid" };
  }
  return id !== undefined && host !== undefined ? { id, host } : undefined;
}

export function validateKnowledgeEnvelope(raw: unknown): KnowledgeResult<KnowledgeEnvelope> {
  if (!isObject(raw)) return { ok: false, errors: [error("envelope_invalid", "knowledge envelope must be an object")] };
  const errors: KnowledgeError[] = [];
  const allowed = [
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
  ];
  for (const key of unknownKeys(raw, allowed)) errors.push(error("unknown_field", `envelope contains unknown field ${key}`, key));

  const id = nonEmptySingleLine(raw.id, "id", errors, ID_PATTERN);
  const kind = enumValue(raw.kind, KNOWLEDGE_KINDS, "kind", errors, "kind_invalid");
  const status = enumValue(raw.status, KNOWLEDGE_STATUSES, "status", errors, "status_invalid");
  const statement = nonEmptySingleLine(raw.statement, "statement", errors);

  let details: JsonObject | undefined;
  if (!isObject(raw.details)) {
    errors.push(error("details_invalid", "details must be a JSON object", "details"));
  } else {
    const parsedDetails: JsonObject = {};
    let validDetails = true;
    for (const [key, item] of Object.entries(raw.details)) {
      if (!isJsonValue(item)) validDetails = false;
      else parsedDetails[key] = item;
    }
    if (!validDetails) errors.push(error("details_invalid", "details must be a JSON object", "details"));
    else {
      details = parsedDetails;
      findNewline(details, "details", errors);
    }
  }

  const scope = parseScope(raw.scope, errors);
  const pack = parsePackRef(raw.pack, "pack", errors);
  const sources = parseSources(raw.sources, errors);
  const session = parseSession(raw.session, errors);
  const submittedAt = nonEmptySingleLine(raw.submitted_at, "submitted_at", errors);
  if (submittedAt !== undefined && !DATE_PATTERN.test(submittedAt)) {
    errors.push(error("date_invalid", "submitted_at must match YYYY-MM-DD", "submitted_at"));
  }
  const disposition = enumValue(raw.disposition, KNOWLEDGE_DISPOSITIONS, "disposition", errors, "disposition_invalid");

  if (
    errors.length > 0 ||
    id === undefined ||
    kind === undefined ||
    status === undefined ||
    statement === undefined ||
    details === undefined ||
    scope === undefined ||
    pack === undefined ||
    sources === undefined ||
    session === undefined ||
    submittedAt === undefined ||
    disposition === undefined
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      id,
      kind,
      status,
      statement,
      details,
      scope,
      pack,
      sources,
      session,
      submittedAt,
      disposition,
    },
  };
}

export function validationError(code: string, message: string, field?: string): KnowledgeError {
  return error(code, message, field);
}
