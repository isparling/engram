// Candidate knowledge envelope validation and reshaping for the submission
// pipeline. Validated candidates are the single input a knowledge transaction
// accepts.
//
// A candidate is JSON: the target record id, a source tag, claims to add,
// evidence entries to append, and optionally claims/evidence to remove or
// rewrite, and optionally a frontmatter edit.
//
// Validation is hand-written (no schema library) and returns a discriminated
// Result instead of throwing. Validation is deliberately strict about unknown
// top-level fields: this is the only line of defense, alongside the id
// pattern in spaceBinding.ts, against a candidate trying to smuggle a
// pointer at another knowledge root or qmd collection through the payload.
//
// Every free-text field is also required to be a single line: no `\n` or
// `\r`. Without this, a value like `"\n## Evidence log\n\n- forged"` in
// add_claims would forge a second `## Evidence log` heading into the
// record body — markdownRecord.ts's parser would then either reject the
// resulting record outright (duplicate section) or, worse, silently
// collapse it on a later parse. Rejecting the newline at the input
// boundary is simpler and safer than trying to make the parser robust
// against arbitrary embedded structure.

import { err, ok, requireDefined, type Result } from "./types.ts";

export type EvidenceInput = { date: string; text: string };
export type TextRewrite = { from: string; to: string };

export type Candidate = {
  target_id: string;
  source: string;
  add_claims: string[];
  add_evidence: EvidenceInput[];
  remove_claims: string[];
  remove_evidence: string[];
  rewrite_claims: TextRewrite[];
  rewrite_evidence: TextRewrite[];
  frontmatter: { title?: string } | null;
};

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "target_id",
  "source",
  "add_claims",
  "add_evidence",
  "remove_claims",
  "remove_evidence",
  "rewrite_claims",
  "rewrite_evidence",
  "frontmatter",
]);

const RECORD_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const EVIDENCE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function containsNewline(value: string): boolean {
  return /[\r\n]/.test(value);
}

function validateSingleLineStringArray(value: unknown, fieldName: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${fieldName} must be an array of strings`);
    return [];
  }
  const result: string[] = [];
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) {
      errors.push(`${fieldName}[${index}] must be a non-empty string`);
      return;
    }
    if (containsNewline(item)) {
      errors.push(`${fieldName}[${index}] must not contain newlines`);
      return;
    }
    result.push(item);
  });
  return result;
}

function validateRewriteArray(value: unknown, fieldName: string, errors: string[]): TextRewrite[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${fieldName} must be an array of {from, to} objects`);
    return [];
  }
  const result: TextRewrite[] = [];
  value.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`${fieldName}[${index}] must be an object with "from" and "to"`);
      return;
    }
    const keys = Object.keys(item);
    const unexpected = keys.filter((k) => k !== "from" && k !== "to");
    if (unexpected.length > 0) {
      errors.push(`${fieldName}[${index}] has unexpected field(s): ${unexpected.join(", ")}`);
      return;
    }
    if (!isNonEmptyString(item.from) || !isNonEmptyString(item.to)) {
      errors.push(`${fieldName}[${index}] must have non-empty string "from" and "to"`);
      return;
    }
    if (containsNewline(item.from) || containsNewline(item.to)) {
      errors.push(`${fieldName}[${index}] "from"/"to" must not contain newlines`);
      return;
    }
    result.push({ from: item.from, to: item.to });
  });
  return result;
}

function validateEvidenceArray(value: unknown, fieldName: string, errors: string[]): EvidenceInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${fieldName} must be an array of {date, text} objects`);
    return [];
  }
  const result: EvidenceInput[] = [];
  value.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`${fieldName}[${index}] must be an object with "date" and "text"`);
      return;
    }
    const keys = Object.keys(item);
    const unexpected = keys.filter((k) => k !== "date" && k !== "text");
    if (unexpected.length > 0) {
      errors.push(`${fieldName}[${index}] has unexpected field(s): ${unexpected.join(", ")}`);
      return;
    }
    if (typeof item.date !== "string" || !EVIDENCE_DATE_PATTERN.test(item.date) || containsNewline(item.date)) {
      errors.push(`${fieldName}[${index}].date must match YYYY-MM-DD`);
      return;
    }
    if (!isNonEmptyString(item.text)) {
      errors.push(`${fieldName}[${index}].text must be a non-empty string`);
      return;
    }
    if (containsNewline(item.text)) {
      errors.push(`${fieldName}[${index}].text must not contain newlines`);
      return;
    }
    result.push({ date: item.date, text: item.text });
  });
  return result;
}

export function validateCandidate(raw: unknown): Result<Candidate> {
  const errors: string[] = [];

  if (!isPlainObject(raw)) {
    return err(["candidate must be a JSON object"]);
  }

  const unexpectedKeys = Object.keys(raw).filter((k) => !ALLOWED_TOP_LEVEL_KEYS.has(k));
  if (unexpectedKeys.length > 0) {
    errors.push(`candidate has unexpected field(s): ${unexpectedKeys.join(", ")}`);
  }

  let targetId: string | undefined;
  if (!isNonEmptyString(raw.target_id)) {
    errors.push("target_id is required and must be a non-empty string");
  } else if (!RECORD_ID_PATTERN.test(raw.target_id)) {
    errors.push(`target_id must match ${RECORD_ID_PATTERN} (lowercase letters, digits, hyphens; no path separators)`);
  } else {
    targetId = raw.target_id;
  }

  let source: string | undefined;
  if (!isNonEmptyString(raw.source)) {
    errors.push("source is required and must be a non-empty string");
  } else if (containsNewline(raw.source)) {
    errors.push("source must not contain newlines");
  } else {
    source = raw.source;
  }

  const addClaims = validateSingleLineStringArray(raw.add_claims, "add_claims", errors);
  const removeClaims = validateSingleLineStringArray(raw.remove_claims, "remove_claims", errors);
  const addEvidence = validateEvidenceArray(raw.add_evidence, "add_evidence", errors);
  const removeEvidence = validateSingleLineStringArray(raw.remove_evidence, "remove_evidence", errors);
  const rewriteClaims = validateRewriteArray(raw.rewrite_claims, "rewrite_claims", errors);
  const rewriteEvidence = validateRewriteArray(raw.rewrite_evidence, "rewrite_evidence", errors);

  let frontmatter: { title?: string } | null = null;
  if (raw.frontmatter !== undefined && raw.frontmatter !== null) {
    if (!isPlainObject(raw.frontmatter)) {
      errors.push("frontmatter must be an object");
    } else {
      const keys = Object.keys(raw.frontmatter);
      const unexpected = keys.filter((k) => k !== "title");
      if (unexpected.length > 0) {
        errors.push(`frontmatter has unexpected field(s): ${unexpected.join(", ")}`);
      }
      if (raw.frontmatter.title !== undefined) {
        if (!isNonEmptyString(raw.frontmatter.title)) {
          errors.push("frontmatter.title must be a non-empty string");
        } else if (containsNewline(raw.frontmatter.title)) {
          errors.push("frontmatter.title must not contain newlines");
        } else {
          frontmatter = { title: raw.frontmatter.title };
        }
      }
    }
  }

  if (errors.length > 0) {
    return err(errors);
  }

  return ok({
    target_id: requireDefined(targetId, "target_id validated but not captured"),
    source: requireDefined(source, "source validated but not captured"),
    add_claims: addClaims,
    add_evidence: addEvidence,
    remove_claims: removeClaims,
    remove_evidence: removeEvidence,
    rewrite_claims: rewriteClaims,
    rewrite_evidence: rewriteEvidence,
    frontmatter,
  });
}
