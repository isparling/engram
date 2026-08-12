// Hand-written parser/serializer for the Markdown record shape:
//
//   ---
//   id: <id>
//   title: <title>
//   updated: <YYYY-MM-DD>
//   ---
//
//   ## Active claims
//
//   - claim text [source: tag]
//
//   ## Evidence log
//
//   - YYYY-MM-DD — entry text [source: tag]
//
// `## Active claims` and `## Evidence log` are the two sections this
// module understands and can mutate. Any OTHER `## ...` section in the
// body is preserved verbatim, in its original position, through parse and
// serialize — a record is free to carry a `## Notes` section (or anything
// else) that is never touched. So is any PREAMBLE: free-form content
// between the frontmatter's closing `---` and the first `##` heading.
// Losing either on write would be a silent, ungated destructive edit —
// exactly what the additive/non-additive gate exists to prevent, and
// exactly what happened here before preambleLines existed: content before
// the first heading was parsed and then never re-emitted.

import { err, ok, requireDefined, type Result } from "./types.ts";

export type RecordFrontmatter = {
  id: string;
  title: string;
  updated: string;
};

export type KnownSection =
  | { kind: "active-claims"; bullets: string[] }
  | { kind: "evidence-log"; bullets: string[] };

export type OtherSection = { kind: "other"; heading: string; lines: string[] };

export type RecordSection = KnownSection | OtherSection;

export type ParsedRecord = {
  frontmatter: RecordFrontmatter;
  /** Raw body lines before the first `## ...` heading, preserved verbatim
   * (including the mandatory blank separator line after the frontmatter
   * delimiter, for a record with no real preamble). A record is free to
   * carry introductory prose here; losing it on the first write would be
   * a silent, ungated destructive edit. */
  preambleLines: string[];
  sections: RecordSection[];
};

const ACTIVE_CLAIMS_HEADING = "## Active claims";
const EVIDENCE_LOG_HEADING = "## Evidence log";

export function parseRecord(text: string): Result<ParsedRecord> {
  const errors: string[] = [];
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));

  if (lines[0] !== "---") {
    return err(["record must begin with a '---' frontmatter delimiter"]);
  }

  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) {
    return err(["record frontmatter is missing its closing '---' delimiter"]);
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const frontmatterFields = new Map<string, string>();
  for (const line of frontmatterLines) {
    if (line.trim() === "") continue;
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*):\s?(.*)$/.exec(line);
    if (!match) {
      errors.push(`unrecognized frontmatter line: ${JSON.stringify(line)}`);
      continue;
    }
    const key = requireDefined(match[1], "frontmatter regex capture group 1");
    const value = requireDefined(match[2], "frontmatter regex capture group 2");
    frontmatterFields.set(key, value.trim());
  }

  for (const required of ["id", "title", "updated"] as const) {
    if (!frontmatterFields.has(required)) {
      errors.push(`frontmatter is missing required field: ${required}`);
    }
  }
  const knownFrontmatterKeys = new Set(["id", "title", "updated"]);
  for (const key of frontmatterFields.keys()) {
    if (!knownFrontmatterKeys.has(key)) {
      errors.push(`frontmatter has unexpected field: ${key}`);
    }
  }

  if (errors.length > 0) {
    return err(errors);
  }

  const frontmatter: RecordFrontmatter = {
    id: requireDefined(frontmatterFields.get("id"), "id present after validation"),
    title: requireDefined(frontmatterFields.get("title"), "title present after validation"),
    updated: requireDefined(frontmatterFields.get("updated"), "updated present after validation"),
  };

  const bodyLines = lines.slice(closingIndex + 1);
  const firstHeadingIndex = bodyLines.findIndex((line) => line.startsWith("## "));
  const preambleLines = firstHeadingIndex === -1 ? bodyLines.slice() : bodyLines.slice(0, firstHeadingIndex);
  const sectionLines = firstHeadingIndex === -1 ? [] : bodyLines.slice(firstHeadingIndex);
  const rawSections = splitIntoSections(sectionLines);

  const sections: RecordSection[] = [];
  let activeClaimsIndex = -1;
  let evidenceLogIndex = -1;

  for (const raw of rawSections) {
    if (raw.heading === ACTIVE_CLAIMS_HEADING) {
      if (activeClaimsIndex !== -1) {
        errors.push(`record has more than one "${ACTIVE_CLAIMS_HEADING}" section`);
        continue;
      }
      const bulletsResult = parseBullets(raw.lines, ACTIVE_CLAIMS_HEADING);
      if (!bulletsResult.ok) {
        errors.push(...bulletsResult.errors);
        continue;
      }
      activeClaimsIndex = sections.length;
      sections.push({ kind: "active-claims", bullets: bulletsResult.value });
    } else if (raw.heading === EVIDENCE_LOG_HEADING) {
      if (evidenceLogIndex !== -1) {
        errors.push(`record has more than one "${EVIDENCE_LOG_HEADING}" section`);
        continue;
      }
      const bulletsResult = parseBullets(raw.lines, EVIDENCE_LOG_HEADING);
      if (!bulletsResult.ok) {
        errors.push(...bulletsResult.errors);
        continue;
      }
      evidenceLogIndex = sections.length;
      sections.push({ kind: "evidence-log", bullets: bulletsResult.value });
    } else {
      sections.push({ kind: "other", heading: raw.heading, lines: raw.lines.slice() });
    }
  }

  if (activeClaimsIndex === -1) {
    errors.push(`record body is missing the "${ACTIVE_CLAIMS_HEADING}" section`);
  }
  if (evidenceLogIndex === -1) {
    errors.push(`record body is missing the "${EVIDENCE_LOG_HEADING}" section`);
  }
  if (activeClaimsIndex !== -1 && evidenceLogIndex !== -1 && activeClaimsIndex > evidenceLogIndex) {
    errors.push(`"${ACTIVE_CLAIMS_HEADING}" must come before "${EVIDENCE_LOG_HEADING}"`);
  }

  if (errors.length > 0) {
    return err(errors);
  }

  return ok({ frontmatter, preambleLines, sections });
}

type RawSection = { heading: string; lines: string[] };

function splitIntoSections(bodyLines: string[]): RawSection[] {
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  for (const line of bodyLines) {
    if (line.startsWith("## ")) {
      current = { heading: line.trimEnd(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
    // lines before the first heading (blank separator lines) are ignored
  }
  return sections;
}

function parseBullets(lines: string[], sectionName: string): Result<string[]> {
  const bullets: string[] = [];
  const errors: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const match = /^- (.+)$/.exec(line);
    if (!match) {
      errors.push(`unrecognized line in "${sectionName}": ${JSON.stringify(line)}`);
      continue;
    }
    const bulletText = requireDefined(match[1], "bullet regex capture group 1");
    bullets.push(bulletText.trimEnd());
  }
  if (errors.length > 0) return err(errors);
  return ok(bullets);
}

export function serializeRecord(record: ParsedRecord): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${record.frontmatter.id}`);
  lines.push(`title: ${record.frontmatter.title}`);
  lines.push(`updated: ${record.frontmatter.updated}`);
  lines.push("---");
  lines.push(...record.preambleLines);

  for (const section of record.sections) {
    if (section.kind === "active-claims") {
      lines.push(ACTIVE_CLAIMS_HEADING);
      lines.push("");
      for (const claim of section.bullets) lines.push(`- ${claim}`);
      lines.push("");
    } else if (section.kind === "evidence-log") {
      lines.push(EVIDENCE_LOG_HEADING);
      lines.push("");
      for (const evidence of section.bullets) lines.push(`- ${evidence}`);
      lines.push("");
    } else {
      lines.push(section.heading);
      lines.push(...section.lines);
    }
  }

  // Normalize to exactly one trailing newline regardless of how the last
  // section's captured lines ended.
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

function findKnownSection(record: ParsedRecord, kind: "active-claims" | "evidence-log"): KnownSection {
  for (const section of record.sections) {
    if (section.kind === kind) return section;
  }
  // parseRecord guarantees both known sections exist exactly once before
  // ever returning ok(...), so reaching here means a ParsedRecord was
  // constructed some other way. That is a programming error, not a
  // user-facing validation failure, so it throws rather than returning a
  // Result.
  throw new Error(`internal invariant violated: parsed record is missing its "${kind}" section`);
}

export function getActiveClaims(record: ParsedRecord): string[] {
  return findKnownSection(record, "active-claims").bullets;
}

export function getEvidenceLog(record: ParsedRecord): string[] {
  return findKnownSection(record, "evidence-log").bullets;
}

/**
 * Returns a new ParsedRecord with the active-claims and evidence-log
 * sections replaced and frontmatter updated, preserving the preamble and
 * every other section (unknown headings, and their relative position)
 * unchanged — no candidate field can touch either.
 */
export function withMutatedContent(
  record: ParsedRecord,
  update: { frontmatter: RecordFrontmatter; activeClaims: string[]; evidenceLog: string[] },
): ParsedRecord {
  const sections: RecordSection[] = record.sections.map((section) => {
    if (section.kind === "active-claims") return { kind: "active-claims", bullets: update.activeClaims };
    if (section.kind === "evidence-log") return { kind: "evidence-log", bullets: update.evidenceLog };
    return section;
  });
  return { frontmatter: update.frontmatter, preambleLines: record.preambleLines, sections };
}
