# Knowledge Model

This document defines the normative vocabulary of the knowledge harness: the roles that
bound responsibility, the layers of knowledge it distinguishes, the scope rules that
make records safe to interpret, the generic record envelope, the lifecycle, the minimum
states, and the universal invariants.

The model states timeless rules. It does not require a particular database, graph
engine, index, or record layout, and it does not describe a deployment stage.

## Why this model exists

Several distinct things are often collapsed into "knowledge": source data, observations,
claims, interpretations, recommendations, summaries, and messages written for a
specific recipient. Collapsing them makes provenance disappear and lets audience-shaped
language flow back into reasoning as if it were evidence.

The harness keeps these concepts explicit while allowing a knowledge pack to choose the
domain vocabulary and durable representation.

## Roles

### Harness

The harness implements universal mechanics:

- bind a host session to an authorized knowledge space;
- accept structured candidate submissions;
- preserve scope and provenance;
- retrieve related records through a guarded adapter;
- propose reconciliation actions;
- enforce state transitions and approval requirements;
- commit validated changes as one logical transaction;
- refresh and verify derived retrieval state;
- render views for audiences and retain presentation receipts;
- create content-free observations about harness behavior.

The harness contains no private knowledge and no domain conclusions.

### Knowledge pack

A pack supplies reusable domain judgment:

- candidate kinds and required fields;
- source classes, validity rules, and evidence grading;
- meaningful scopes, relationships, and controlled vocabulary;
- elicitation questions and interpretation policy;
- promotion, contradiction, expiry, and review rules;
- recommendation policy;
- view templates and audience-adaptation guidance;
- domain-specific validators, source adapters, or deterministic tools.

A pack may produce candidates and proposed dispositions. It does not bypass the
harness transaction or write active knowledge directly.

### Knowledge space

A space owns private durable state:

- evidence and observations;
- candidate, active, contested, and retired claims;
- concrete subjects, contexts, views, and audiences;
- interpretations, decisions, and recommendations;
- presentation artifacts and receipts where retention is appropriate;
- the configuration that maps its existing files to the shared protocol.

A space is normally a separate repository or filesystem root. It may use an existing
layout; adopting the harness does not require immediately reorganizing a mature corpus.
The space is the hard ownership, storage, privacy, and authorization boundary.

### Local binding

A binding connects one installed harness to one space without committing machine-local
or secret values:

- absolute paths;
- derived retrieval state location;
- host session location;
- credentials and provider restrictions;
- enabled pack versions;
- environment capabilities.

Bindings are not portable knowledge and must not become an untracked second
implementation.

## Knowledge layers

### Evidence

Evidence is the most source-faithful record the space has chosen to preserve: a
measurement, event, source artifact, reported experience, or external record. Evidence
must carry provenance and relevant collection context.

Evidence is stable, not necessarily perfect or objective. It may be incomplete,
subjective, noisy, or later corrected. Corrections are explicit; an audience renderer
never changes source evidence.

### Claim

A claim is a proposition supported, contradicted, or left uncertain by evidence. It
has explicit scope, confidence or evidence status, applicability, and review state.

Model-generated text begins as a candidate claim. A retrieved claim, summary, or
presentation is not evidence for itself.

### Interpretation

An interpretation states what selected evidence and claims mean under an explicit
perspective or policy. Different perspectives may interpret the same records
differently without changing them.

Interpretations name the policy, pack, persona, or model that produced them when that
provenance matters.

### Decision or recommendation

A decision records an action chosen. A recommendation proposes an action and its
rationale. Both identify the evidence, claims, and interpretation on which they rely.

If adapting communication for an audience changes the action being recommended, the
result is a distinct recommendation, not merely a different presentation.

### View

A view is an audience-independent semantic projection. It defines the question being
answered and the records, aggregation, ordering, and grouping needed to answer it.
Views are derived. A materialized view may be committed when it is useful for humans or
other tools, but authoritative evidence and claims remain traceable behind it.

### Audience

An audience contract describes a recipient or recipient class:

- identity and role;
- authorized spaces and records;
- decisions they need to make;
- familiarity and useful level of detail;
- communication needs and preferences;
- required uncertainty or safety language;
- relevant, evidence-backed communication traits.

Audience traits are claims about a subject, not permanent labels embedded without
evidence. Authorization is applied before view data is rendered, not after generation.

### Delivery

A delivery contract states the channel and physical constraints of a presentation:
report, interactive response, message draft, status update, word limit, cadence, or
another format.

Delivery changes shape, not truth.

### Presentation

A presentation is a rendered instance of a view for an audience under a delivery
contract. It may change selection within the view, depth, ordering, vocabulary, tone,
and framing while remaining faithful to authorized records.

Presentations are communication artifacts, not evidence. A recipient's later response
or outcome may become new evidence when captured separately.

### Presentation receipt

A material presentation retains enough provenance to audit what was shown:

```yaml
presentation_id: sample-presentation
view_id: sample-view
view_version: 1
audience_id: sample-audience
audience_version: 1
delivery_id: sample-delivery
source_record_ids: [sample-record]
interpretation_policy: sample-pack/default
recommendation_ids: []
model: provider/model
generated_at: 2001-02-03T04:05:06Z
```

Source records, view, audience, delivery, and material recommendations must be
reconstructable from the receipt.

## Scope model

Records may use independent scope dimensions:

- **space** — hard ownership, storage, privacy, and authorization boundary;
- **subject** — person, team, repository, service, project, or other entity;
- **topic** — any area of knowledge;
- **actor role** — the role in which activity occurred;
- **context** — a period, incident, project, appointment, or time period;
- **source class** — measurement, consultation, decision, research, retrospective;
- **audience** — who may receive a presentation, not what the record means.

Packs define which dimensions matter. The core preserves and enforces them without a
global ontology.

## Generic record envelope

The record envelope stays small and extensible. This is illustrative:

```yaml
id: sample-record
kind: claim
status: candidate
scope:
  space: sample-space
  subjects: [sample-subject]
  topics: [sample-topic]
  actor_roles: [sample-role]
  contexts: [sample-context]
statement: "A scoped observation with a bounded claim."
sources:
  - type: sample-source-class
    ref: sample-source
evidence:
  grade: sample-grade
  confounders: []
review:
  requires_human_approval: true
relationships:
  supports: []
  contradicts: []
  replaces: []
```

Domain details remain in pack-defined fields or linked records. The core does not
enumerate every possible topic, evidence grade, or subject type.

## Universal lifecycle

```text
source episode
      |
      v
extract candidates
      |
      v
resolve scope + provenance
      |
      v
retrieve related authorized knowledge
      |
      v
propose reconciliation
      |
      +--> supports existing
      +--> contradicts / contests
      +--> refines / merges
      +--> replaces / retires
      +--> creates new candidate
      |
      v
apply pack policy + approval
      |
      v
commit one transaction
      |
      v
regenerate affected views + refresh derived state + verify
```

The trigger may be a session, a conversation, an observed event, a scheduled period, or
a manual request. Triggers vary; the lifecycle does not.

## Minimum states and transitions

The model needs only:

- `candidate` — proposed but not active knowledge;
- `active` — approved for its stated scope and evidence grade;
- `contested` — materially contradicted or under explicit review;
- `retired` — no longer active, with the reason retained.

Replacement is a relationship plus a transition, not deletion. Packs may render
additional domain language, but they must map it to these durable meanings before the
core gains more states.

## Space and federation rules

1. A session has exactly one primary knowledge space.
2. Tools receive the active space from the harness; the model does not choose an
   arbitrary filesystem root or retrieval collection.
3. Session transcripts, derived retrieval state, and caches inherit the space's
   sensitivity even though they are derived.
4. Cross-space retrieval is closed by default.
5. Switching primary spaces starts a new host session without conversational carryover
   where the host can control session lifecycle. Where it cannot, the machine registers
   one space and the harness validates against it, which is a weaker guarantee and is
   reported as such.
6. Cross-space publication or generalization, when later justified, creates a new
   reviewed record in the target space. It never exposes sibling-space content by
   default.
7. Distinct owners, unrelated private subjects, and subjects with different consent or
   confidentiality obligations use physically separate spaces.

## Derived retrieval contract

- Durable records in the authorized space are the source of truth.
- The active-space derived index is derived and reproducible.
- The harness scopes retrieval to the active space and records a retrieval receipt.
- Packs may define allowed source classes, relevance thresholds, query construction,
  and fallback policy.
- Raw host sessions, unapproved candidates, process documents, and presentations are not
  indexed as active knowledge by default.
- The active-space derived index reflects only authorized durable records and is
  verified for consistency with them.

## Universal invariants

- Model output is never active knowledge without the applicable disposition.
- Summaries, views, retrieved claims, and presentations do not become new evidence by
  repetition.
- Every active claim is traceable to evidence, scope, policy, and approval.
- Non-additive changes are visible and require the configured approval.
- Audience adaptation cannot change evidence, hide required uncertainty, or smuggle a
  changed action into presentation-only logic.
- Broader scope and cross-subject generalization are explicit transactions.
- Authorization precedes retrieval and rendering.
- Durable state is inspectable without the host, the pack, or derived state.
- Private knowledge never becomes a fixture or release payload.
- Content-free harness observations are separate from domain knowledge and cannot read
  from the active knowledge space during export.
