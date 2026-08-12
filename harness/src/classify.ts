// Mutation classification: a planned delta is additive, non-additive, or
// no-change, derived from the assembled plan rather than from intent.
//
// Classifies a candidate against a parsed record and plans the resulting
// Markdown mutation.
//
// Classification rule: additive means only appending
// evidence and/or adding new claims. Non-additive means removing or
// rewriting an existing claim or evidence entry, or altering frontmatter.
//
// ASSUMPTION (documented, not litigated further — see harness/README.md):
// every commit mechanically stamps `updated` to the submission date. That
// stamp is not, by itself, a classification-relevant frontmatter change;
// only a candidate that explicitly requests a frontmatter edit (currently
// just `title`) makes the candidate non-additive. Otherwise a harmless
// bookkeeping timestamp would force every candidate through the approval
// gate, which defeats the additive path entirely.
//
// Every remove/rewrite directive is resolved against the ORIGINAL record
// state, not applied as a sequential pipeline: a rewrite whose `to` value
// happens to match some other original entry's text must not make that
// unrelated entry vanish just because a later step compares against
// already-mutated state. Directives that are individually unambiguous but
// jointly conflicting (the same original text named by both a remove and
// a rewrite, or by two different rewrites) are rejected outright rather
// than resolved by pipeline order, which is exactly what "order" was
// silently deciding before.
//
// Classification is NOT trusted from candidate directives alone. A
// candidate that only names add_claims/add_evidence LOOKS additive, but
// the actual planned mutation is what can destroy content — through a
// latent bug in this file, in withMutatedContent, or in the parser's
// round-trip fidelity (preamble loss was exactly such a bug: it discarded
// content that no candidate ever asked to touch, and would have kept
// classifying as additive forever, because the classification check never
// looked at the record). `mutationPreservesAllContent` compares the
// planned `after` against the pristine `before` directly — preamble,
// every "other" section, and every original claim/evidence entry must
// still be present — and classification is non-additive if EITHER the
// candidate declared a destructive directive OR the actual plan drops or
// alters anything, whichever fires. This makes classification a property
// of the mutation, not a report of intent.

import type { Candidate, TextRewrite } from "./candidate.ts";
import { renderUnifiedDiff } from "./diff.ts";
import {
  getActiveClaims,
  getEvidenceLog,
  withMutatedContent,
  type OtherSection,
  type ParsedRecord,
} from "./markdownRecord.ts";
import { serializeRecord } from "./markdownRecord.ts";
import { err, ok, type Result } from "./types.ts";

export type Classification = "additive" | "non-additive";

export type MutationPlan = {
  classification: Classification;
  before: ParsedRecord;
  after: ParsedRecord;
  beforeText: string;
  afterText: string;
  diff: string;
};

/**
 * Resolves remove/rewrite/add directives for a single flat text list
 * (active claims, or evidence log entries) against its original state.
 * Returns errors for: a remove/rewrite target that doesn't exist in the
 * original list, two rewrite directives naming the same original text, or
 * an original text named by both a remove and a rewrite directive.
 */
function resolveTextList(
  original: string[],
  removeList: string[],
  rewriteList: TextRewrite[],
  additions: string[],
  fieldLabel: string,
): Result<string[]> {
  const errors: string[] = [];
  const originalSet = new Set(original);

  for (const text of removeList) {
    if (!originalSet.has(text)) {
      errors.push(`remove target not found in ${fieldLabel}: ${JSON.stringify(text)}`);
    }
  }

  const rewriteFromCounts = new Map<string, number>();
  for (const rewrite of rewriteList) {
    if (!originalSet.has(rewrite.from)) {
      errors.push(`rewrite target not found in ${fieldLabel}: ${JSON.stringify(rewrite.from)}`);
    }
    rewriteFromCounts.set(rewrite.from, (rewriteFromCounts.get(rewrite.from) ?? 0) + 1);
  }

  for (const [from, count] of rewriteFromCounts) {
    if (count > 1) {
      errors.push(`${fieldLabel} has ${count} conflicting rewrite directives for the same original text: ${JSON.stringify(from)}`);
    }
  }

  const removeSet = new Set(removeList);
  for (const from of rewriteFromCounts.keys()) {
    if (removeSet.has(from)) {
      errors.push(`${fieldLabel} text is targeted by both a remove and a rewrite directive: ${JSON.stringify(from)}`);
    }
  }

  if (errors.length > 0) {
    return err(errors);
  }

  const rewriteMap = new Map(rewriteList.map((rewrite) => [rewrite.from, rewrite.to]));
  const resolved: string[] = [];
  for (const item of original) {
    if (removeSet.has(item)) continue;
    const rewritten = rewriteMap.get(item);
    resolved.push(rewritten !== undefined ? rewritten : item);
  }
  for (const addition of additions) {
    resolved.push(addition);
  }

  return ok(resolved);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** before ⊆ after as a multiset: every original entry (counting
 * duplicates) must still appear in after at least as many times. A
 * rewrite or removal makes the original text's count drop, which this
 * catches regardless of what the candidate's directives claimed to do;
 * pure additions only ever raise counts, so they always pass. */
function isTextMultisetSubset(before: string[], after: string[]): boolean {
  const remaining = new Map<string, number>();
  for (const item of after) {
    remaining.set(item, (remaining.get(item) ?? 0) + 1);
  }
  for (const item of before) {
    const count = remaining.get(item) ?? 0;
    if (count <= 0) return false;
    remaining.set(item, count - 1);
  }
  return true;
}

/**
 * True iff `after` preserves everything `before` had: the same id and
 * title (the mechanical `updated` bump is expected and excluded), the
 * same preamble, every "other" section unchanged in place, and every
 * original active-claims/evidence-log entry still present at least as
 * many times as it originally appeared. False means the plan destroys or
 * alters pre-existing content, independent of what the candidate declared.
 *
 * Exported so this safety net can be unit-tested directly against
 * synthetic before/after pairs. Under the current (correct)
 * resolveTextList/withMutatedContent implementation, there is no
 * candidate reachable through the public submitCandidate/planMutation API
 * that makes this return false for a directive-declared-additive
 * candidate — which is the point: it is a structural backstop against a
 * FUTURE bug in this file or in markdownRecord.ts's round-trip fidelity
 * (preamble loss was exactly such a bug), not a path exercised by valid
 * input today.
 */
export function mutationPreservesAllContent(before: ParsedRecord, after: ParsedRecord): boolean {
  if (before.frontmatter.id !== after.frontmatter.id) return false;
  if (before.frontmatter.title !== after.frontmatter.title) return false;

  if (!arraysEqual(before.preambleLines, after.preambleLines)) return false;

  const beforeOthers = before.sections.filter((s): s is OtherSection => s.kind === "other");
  const afterOthers = after.sections.filter((s): s is OtherSection => s.kind === "other");
  if (beforeOthers.length !== afterOthers.length) return false;
  for (let i = 0; i < beforeOthers.length; i++) {
    const beforeSection = beforeOthers[i];
    const afterSection = afterOthers[i];
    if (beforeSection === undefined || afterSection === undefined) return false;
    if (beforeSection.heading !== afterSection.heading) return false;
    if (!arraysEqual(beforeSection.lines, afterSection.lines)) return false;
  }

  if (!isTextMultisetSubset(getActiveClaims(before), getActiveClaims(after))) return false;
  if (!isTextMultisetSubset(getEvidenceLog(before), getEvidenceLog(after))) return false;

  return true;
}

export type ContentPreservationCheck = (before: ParsedRecord, after: ParsedRecord) => boolean;

export function planMutation(
  recordText: string,
  record: ParsedRecord,
  candidate: Candidate,
  submittedAt: string,
  /** Testing seam, defaulting to the real mutationPreservesAllContent.
   * Mirrors the spawnFn/writeRecord injection pattern used elsewhere:
   * lets a test prove the classification WIRING itself combines this
   * check with the directive-declared signal, independent of whether a
   * real candidate can currently drive the real check to false. */
  contentCheck: ContentPreservationCheck = mutationPreservesAllContent,
): Result<MutationPlan> {
  const claimsResult = resolveTextList(
    getActiveClaims(record),
    candidate.remove_claims,
    candidate.rewrite_claims,
    candidate.add_claims.map((text) => `${text} [source: ${candidate.source}]`),
    "active claims",
  );
  const evidenceResult = resolveTextList(
    getEvidenceLog(record),
    candidate.remove_evidence,
    candidate.rewrite_evidence,
    candidate.add_evidence.map((evidence) => `${evidence.date} — ${evidence.text} [source: ${candidate.source}]`),
    "evidence log",
  );

  const errors: string[] = [];
  if (!claimsResult.ok) errors.push(...claimsResult.errors);
  if (!evidenceResult.ok) errors.push(...evidenceResult.errors);
  if (errors.length > 0) {
    return err(errors);
  }
  // Narrowed by the checks above, but the checks live on separate Result
  // values so TypeScript can't see that from `errors.length === 0` alone.
  if (!claimsResult.ok || !evidenceResult.ok) {
    return err(["internal invariant violated: resolved list marked ok=false without contributing errors"]);
  }

  const after = withMutatedContent(record, {
    frontmatter: {
      id: record.frontmatter.id,
      title: candidate.frontmatter?.title ?? record.frontmatter.title,
      updated: submittedAt,
    },
    activeClaims: claimsResult.value,
    evidenceLog: evidenceResult.value,
  });

  const declaredNonAdditive =
    candidate.remove_claims.length > 0 ||
    candidate.remove_evidence.length > 0 ||
    candidate.rewrite_claims.length > 0 ||
    candidate.rewrite_evidence.length > 0 ||
    candidate.frontmatter !== null;

  // The authoritative signal: does the actual planned mutation drop or
  // alter any pre-existing content? This can fire even when
  // declaredNonAdditive is false — e.g. a parser/serializer round-trip
  // bug that silently drops content the candidate never asked to touch —
  // which is exactly the property "no commit may destroy content the
  // candidate did not ask to change" requires.
  const contentPreserved = contentCheck(record, after);

  const classification: Classification = declaredNonAdditive || !contentPreserved ? "non-additive" : "additive";

  const afterText = serializeRecord(after);
  const diff = renderUnifiedDiff(record.frontmatter.id, recordText, afterText);

  return ok({
    classification,
    before: record,
    after,
    beforeText: recordText,
    afterText,
    diff,
  });
}
