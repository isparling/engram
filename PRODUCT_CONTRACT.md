# Product Contract

## Product boundary

The product is a knowledge harness. It turns scoped activity into evidence-bearing,
reviewable, retrievable knowledge without owning that knowledge. The harness provides
the universal mechanics of capture, reconciliation, approval, and presentation;
reusable knowledge packs supply domain-specific judgment; independent knowledge spaces
own their private durable state.

The product operates over many independent spaces. Supporting multiple spaces is
necessary for ownership and portability; it is not a commitment to a hosted or shared
service. The harness does not claim to solve knowledge management generally.

## Supported lifecycle

Every knowledge operation follows the universal lifecycle: a source episode produces
candidates; scope and provenance are resolved; related authorized records are
retrieved; reconciliation is proposed; pack policy and the applicable approval are
applied; validated changes commit as one transaction; affected views are regenerated
and derived state is refreshed and verified.

The trigger may be a session, a conversation, an observed event, a scheduled period, or
a manual request. Triggers vary; the lifecycle does not. Every candidate record remains
inactive until the applicable disposition is applied.

## Approval and transaction guarantees

- Exactly one active knowledge space per operation. An operation resolves its space
  before any knowledge read or write and never selects an arbitrary filesystem root or
  collection.
- Authorized retrieval only. Retrieval is scoped to the active space; cross-space
  retrieval is closed by default, and a model cannot discover sibling space names or
  override the bound space.
- Candidates require the applicable approval before non-additive durable change.
  Authorization is applied before view data is rendered, and audience adaptation cannot
  change evidence or hide required uncertainty.
- All validated changes of one operation commit as one logical transaction. The
  transaction plan lists every intended durable mutation before approval.
- Rejected changes leave authoritative records unchanged. Rejection is the absence of a
  commit, not a partial write.
- Derived retrieval state may become stale without corrupting committed records.
  Durable records in the authorized space are the source of truth; derived state is
  disposable and rebuilt from them.
- Private knowledge does not become a release payload. A release contains no binding,
  credential, session, index, presentation, or knowledge record.

## Failure and rejection semantics

- A rejected candidate produces no durable mutation; the authoritative corpus is
  unchanged by the operation.
- An operation that cannot resolve the active space, cannot satisfy authorization, or
  receives malformed input fails closed with a concrete diagnostic and no mutation.
- A miss, malformed retrieval output, a foreign locator, a path escape, and invalid
  current record content are distinct failures; each produces no plan.
- A failure while refreshing derived state never changes which durable records are
  authoritative. Derived state is rebuilt from the authorized corpus; stale derived
  state degrades retrieval freshness, not record integrity.
- Partial-write recovery and derived-state staleness are explicit; a failed commit is
  never reported as success.

## Synthetic acceptance properties

Acceptance properties are expressed only over generic synthetic spaces and records
(sample-space, sample-record, sample-subject, sample-pack). They are not claims about
any real corpus.

- A synthetic candidate submitted to a synthetic space remains inactive until the
  configured approval is applied; applying the approval commits the record in one
  transaction, after which it is active for its stated scope and evidence grade.
- A rejected synthetic candidate leaves the space's authoritative records unchanged.
- Deleting the synthetic derived retrieval state and rebuilding it from the space's
  durable records restores equivalent retrieval results.
- A retrieval scoped to one synthetic space never returns records of another synthetic
  space, even when both are present on the same machine.
- A release built from a synthetic space contains no synthetic record, credential, or
  derived state.

## Explicit exclusions

The product does not:

- determine objective truth or replace human and domain judgment;
- ingest raw sessions directly into a durable corpus;
- promote candidates or generalize across spaces autonomously;
- operate as a hosted service, central knowledge lake, or shared platform;
- make a derived retrieval layer an authorization boundary;
- replace the host, domain tools, source repositories, or record systems it works with;
- provide identity, authentication, or access management beyond the authorization
  enforced at the active-space boundary;
- guarantee the availability, durability, or backup of space-owned storage.
