// Guarded record listing: a host mechanic for capture materialization that
// enumerates the active space's records root and filters exactly, in memory,
// by pack id and status.
//
// Two invariants shape this module:
//
// 1. The filesystem guard is shared, not reimplemented. Enumeration goes
//    through retrieveEnumeratedRecords — the same candidate-guard sequence
//    (`safeRelativeMarkdownPath` containment + realpath checks) guarded
//    search uses — so a symlink escaping the records root FAILS the listing
//    with a path_escape error rather than being silently skipped or followed.
//    No qmd process is ever spawned: enumeration reads the records root
//    directly.
// 2. No caller-supplied filesystem root exists in the interface. The only
//    root involved is the active space's bound recordsRoot; the filter is
//    pack id + statuses, both evaluated exactly against parsed records.

import { retrieveEnumeratedRecords, type GuardedRetrievalFilter } from "./knowledgeRetrieval.ts";
import type { ActiveSpace } from "./spaceRegistry.ts";
import type { KnowledgeError, KnowledgeRecord, KnowledgeResult } from "./knowledgeTypes.ts";

export type KnowledgeListingFilter = {
  packId: string;
  statuses: readonly KnowledgeRecord["status"][];
};

// The listing is a host mechanic, not an audience-scoped view: materialization
// needs every record of a pack regardless of which audience could see it. The
// retrieval filter below is therefore a permissive host policy whose only real
// work is routing every record through the shared containment guards; source
// classification collapses to one host class so no record is dropped for
// having a class the pack's presentation policy would withhold.
const HOST_SOURCE_CLASS = "record";

function hostListingRetrievalFilter(): GuardedRetrievalFilter {
  return {
    audienceId: "host-record-listing",
    requestedSourceClasses: [HOST_SOURCE_CLASS],
    allowedSourceClasses: [HOST_SOURCE_CLASS],
    includePresentations: false,
    relevanceThreshold: null,
    classifySource: () => HOST_SOURCE_CLASS,
    isEligible: () => true,
    authorize: () => true,
  };
}

function listingError(code: string, message: string, field?: string): KnowledgeError {
  return field === undefined
    ? { kind: "validation", code, message }
    : { kind: "validation", code, field, message };
}

export async function listKnowledgeRecords(
  active: ActiveSpace,
  filter: KnowledgeListingFilter,
): Promise<KnowledgeResult<KnowledgeRecord[]>> {
  if (typeof filter.packId !== "string" || filter.packId.length === 0) {
    return {
      ok: false,
      errors: [listingError("listing_filter_invalid", "packId must be a non-empty string", "packId")],
    };
  }
  if (!Array.isArray(filter.statuses) || filter.statuses.length === 0) {
    return {
      ok: false,
      errors: [listingError("listing_filter_invalid", "statuses must be a non-empty array", "statuses")],
    };
  }

  const outcome = await retrieveEnumeratedRecords(active, hostListingRetrievalFilter());
  if (outcome.kind === "failure") return { ok: false, errors: outcome.errors };

  const records = outcome.records
    .map((related) => related.record)
    .filter((record) => record.pack.id === filter.packId && filter.statuses.includes(record.status))
    // Deterministic ordering by record id regardless of directory-read order.
    .sort((left, right) => left.id.localeCompare(right.id));
  return { ok: true, value: records };
}
