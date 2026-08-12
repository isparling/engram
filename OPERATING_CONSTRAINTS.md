# Operating Constraints

Each constraint states a durable rule that binds the public contract, with the rationale
that justifies it.

## Independent ownership boundaries

The harness provides universal mechanics, packs supply reusable domain judgment, and
knowledge spaces own their private durable records. No component absorbs another's
responsibility: the harness holds no private knowledge, a pack holds no space instances,
a binding holds no portable knowledge, and a space holds no harness implementation.

Rationale: Collapsing ownership makes provenance and privacy unenforceable. When one
component silently takes over another's role, domain reasoning, machine configuration,
and private content drift toward a single owner that cannot keep their access rules
apart, and the boundary that private knowledge depends on stops being a real boundary.

## Evidence and provenance integrity

Evidence and claims remain traceable to their sources, scope, and collection context.
Claims, interpretations, decisions, and recommendations stay distinguishable from the
evidence behind them, and derived or audience-shaped output never becomes new evidence
by repetition.

Rationale: Review and audit depend on being able to ask what a record rests on. If
model-generated or presentation-shaped text re-enters reasoning as evidence, the corpus
silently accumulates unverifiable authority and the harness stops being inspectable.

## Deliberate promotion and approval

The harness may automate extraction, comparison, and proposal. It never promotes a
candidate into active knowledge without the applicable approval, and non-additive
changes and broader generalization are explicit, visible transactions.

Rationale: Automation without approval would launder model output into authority.
Keeping promotion deliberate preserves a visible seam between what was proposed and
what was accepted, which is the difference between a growing record and an accumulating
echo.

## Derived state is not authority

Indexes, materialized views, and other derived retrieval state are disposable and
rebuilt from the authorized corpus. Derived state is not a source of truth and never an
authorization boundary.

Rationale: Treating derived state as authoritative silently moves power from reviewed
records to unverified projections and makes authorization depend on the retrieval
mechanism instead of the space boundary. Rebuildability keeps derived state a
performance convenience rather than a second source of truth.

## Immutable release boundaries

Consuming environments use versioned, immutable releases and do not change installed
behavior in place. Space-owned knowledge is a runtime input, not release content, and
private knowledge never becomes a release payload.

Rationale: Immutability makes installed behavior auditable and upgrades explicit.
Including private knowledge in a release would cross the space boundary at distribution
time and turn a reviewable artifact into a disclosure, so the release must be able to
stand alone without any space content.

## Complexity requires demonstrated value

Every schema field, abstraction, configuration surface, and compatibility promise
creates ongoing cost. Add them only when an observed behavior requires them, and prefer
visible records, explicit transactions, and deletion.

Rationale: Generality built ahead of a demonstrated need is the main source of
maintenance cost and boundary erosion. Requiring evidence before adding machinery keeps
the harness small enough that its guarantees can be inspected and enforced.