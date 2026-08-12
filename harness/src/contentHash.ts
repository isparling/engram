// Content hashing used to detect record changes across preview, approval, and
// commit.
//
// Binds an `approval_required` result to the exact MUTATION the caller saw,
// not merely to the record it started from.
//
// Hashing the record alone is insufficient and was a real defect: it detects
// that the record changed under the caller, but it does not detect that the
// caller approved a DIFFERENT mutation. With a record-only hash, previewing
// candidate A against an unchanged record and then approving candidate B
// with A's hash commits B — a diff the caller never saw. The submission date
// has the same effect, since it changes the plan without touching the record.
//
// `hashPlan` therefore covers both endpoints of the diff: the exact bytes
// read and the exact bytes that would be written.

import { createHash } from "node:crypto";

export function hashRecordText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Hashes the complete mutation: where it lands, the record as read, and the
 * text that would replace it. Any change to any of the three — a different
 * destination, a modified record, a different candidate, or a submission date
 * that alters the result — produces a different hash, so an approval cannot
 * carry across to another mutation.
 *
 * The destination is included because before/after text alone is not a unique
 * mutation: two spaces holding byte-identical records make the same textual
 * transition, so a hash previewed in one space would otherwise approve the
 * commit in another after a binding change.
 *
 * The record is hashed as raw bytes rather than decoded text. Decoding first
 * maps every invalid UTF-8 sequence to U+FFFD, so distinct byte-level edits
 * would collide and an intervening change could commit instead of being
 * refused as stale.
 *
 * Components are length-prefixed so no triple can collide with a different
 * triple through concatenation.
 */
export function hashPlan(recordPath: string, recordBytes: Buffer, afterText: string): string {
  const after = Buffer.from(afterText, "utf8");
  const destination = Buffer.from(recordPath, "utf8");
  return createHash("sha256")
    .update(`${destination.length}\n`)
    .update(destination)
    .update(`\n${recordBytes.length}\n`)
    .update(recordBytes)
    .update(`\n${after.length}\n`)
    .update(after)
    .digest("hex");
}
