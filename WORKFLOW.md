# Observation-to-Release Workflow

This document governs development of the harness and its reusable packs. It is
separate from the knowledge lifecycle the product provides to a knowledge space; that
lifecycle is defined in [KNOWLEDGE_MODEL.md](KNOWLEDGE_MODEL.md).

Beads is the system of record for product work. The goal is traceability without
ceremony: every released behavior should lead back to an observed need, and every
active item should make its next evidence gap obvious.

This document defines semantics, not Beads CLI syntax. Tracker-specific commands,
labels, or automation belong here only after the repository commits to them.

## Product-work lifecycle

```text
observed -> reproducing -> ready -> implementing -> verified -> released
                  \                                  /
                   +---- not reproducible / stop ---+
```

| State | Exit evidence |
| --- | --- |
| `observed` | The behavior, context class, impact, harness release, and permitted evidence are recorded |
| `reproducing` | A personal or synthetic reproduction exists, or the limits and next attempt are recorded |
| `ready` | Scope and acceptance criteria follow from the reproduction; dependencies are explicit |
| `implementing` | The smallest coherent change is in progress and linked to the Bead |
| `verified` | The reproduction passes, relevant regressions pass, and affected contracts are current |
| `released` | A published release identifier is recorded and the item appears in its notes |

`not reproducible` is a conclusion, not a failure. Preserve the observation and the
attempts; do not implement a guess. An urgent mitigation may proceed only when the
Bead states the risk, a falsifiable acceptance check, and why normal reproduction is
impossible.

## Sources of observations

Observations may come from:

- development against synthetic spaces;
- use with personal knowledge spaces such as fitness and wellness;
- development of a reusable pack;
- use of an immutable release in a work environment.

The source changes which evidence is permitted, not how seriously the observation is
treated. Work observations use the restricted lane below.

Use one Bead for one independently verifiable behavior. A normal observation contains:

```text
Observation:
Context class:
Harness release:
Host agent and qmd compatibility:
Expected behavior:
Actual behavior:
Impact or frequency:
Permitted evidence:
Sensitivity check:
```

Describe behavior before proposing a solution. Combine duplicates by linking them
while preserving frequency and context information. Ideas that do not come from use
may be recorded as hypotheses, but they remain below observed work until evidence or
a clear maintenance benefit justifies them.

## Restricted work-observation lane

The work environment may reveal product behavior, but it is not a source of fixtures,
examples, or debugging payloads for this repository. `/observe` may help prepare a
record that contains only allowlisted fields such as:

```text
Harness release:
Host agent and qmd compatibility:
Affected generic capability:
Expected generic behavior:
Observed generic behavior:
Impact class and approximate frequency:
Whether a synthetic reproduction appears possible:
```

It must not contain:

- source code, repository structure, file or symbol names;
- raw or summarized sessions, prompts, outputs, or knowledge records;
- company, product, project, customer, or person names;
- metrics, strategy, directional plans, incident, financial, or operational details;
- credentials, identifiers, URLs, screenshots, stack traces, or proprietary payloads;
- any fact whose disclosure depends on trusting an automated sanitizer.

Before an observation leaves work, the user reviews it manually and exports it
through a work-approved path. There is no automatic telemetry or work-to-personal
transport. If a content-free description no longer preserves the behavior, mark the
issue non-exportable and keep it in the work environment.

The personal Bead records the allowlisted observation, then creates a fresh synthetic
reproduction. Never reconstruct the work content from memory merely to make the
reproduction look realistic.

## Reproduction

A useful reproduction:

1. runs in the personal development environment;
2. depends only on synthetic or explicitly personal data;
3. isolates the smallest behavior that matters;
4. demonstrates the gap before implementation;
5. has an observable result that can become an acceptance check.

Put executable, repeatable reproductions in `benchmarks/`. Keep a short manual
reproduction in the Bead when automation would cost more than recurrence. Keep
exploratory code out of release contents.

For boundary failures, the reproduction must use at least two synthetic spaces and
assert both the intended result and the absence of cross-space data. For rendering
failures, preserve the view, audience, delivery, source-record references, and receipt
shape without copying private content.

## Selecting work

Prioritize by personal impact and learning value:

1. privacy, authorization, or release-boundary violations;
2. corruption, provenance loss, or non-atomic knowledge transactions;
3. regressions in released behavior;
4. frequent blocks or repeated manual work;
5. improvements with a clear reproduction;
6. experiments that cheaply reduce an important uncertainty.

Dependencies should represent real ordering constraints. Do not make uncertain future
work look settled by expanding the dependency tree.

## Implementation

Before changing durable code, the Bead should answer:

- What observed behavior is changing?
- What result will count as resolved?
- Why is this the smallest useful change?
- Does the host agent or qmd already provide the needed behavior?
- Does the change belong in the harness, a pack, a space schema, or a binding?
- Which privacy, transaction, retrieval, or presentation behavior could regress?

During implementation:

- keep changes within the narrowest coherent layer;
- add or update a benchmark when recurrence would be costly;
- use synthetic spaces and subjects in repository tests;
- avoid options and abstractions not required by current acceptance criteria;
- update stable documentation in the same change when a boundary or contract changes;
- put unrelated observations in separate Beads rather than expanding scope silently.

A pack may define extraction guidance, schemas, reconciliation policy, approval policy,
and views. It may not bypass the harness transaction, retrieval authorization, or
receipt contracts. Space contents and local bindings do not enter release artifacts.

## Verification

Verification is proportional to the change. At minimum:

- rerun the original reproduction;
- run focused checks for the changed behavior;
- run broader benchmarks when a shared path changed;
- test stale, missing, malformed, and unauthorized inputs where relevant;
- inspect the diff and package for private data, secrets, and accidental fixtures;
- confirm installation produces a release artifact rather than a development
  dependency.

Changes to shared lifecycle code also verify transaction rollback and space isolation.
Changes to retrieval verify explicit space binding and qmd freshness behavior.
Changes to presentation verify authorization, source references, and receipts.

Record commands or manual checks and their results in the Bead. A passing broad suite
without a link to the observed behavior is weaker than a small targeted reproduction.

## Release inclusion

An item reaches `released` only after:

1. verification is recorded;
2. the change is part of an immutable, versioned artifact;
3. release notes identify the user-visible result or internal risk reduction;
4. the Bead records the release identifier.

Several verified Beads may ship together. Do not mark them released merely because
they are merged or present on a development branch. See
[RELEASES.md](RELEASES.md) for package and work-machine requirements.

## Learning after release

Released use begins another observation cycle. Do not patch a work installation or a
personal space to conceal a harness defect. Record the behavior against the exact
release, reproduce it in an allowed environment, and publish a succeeding release.

Repeated mechanics across distinct packs justify core behavior only when they require
the same invariant; differing domain judgment stays in the pack; architectural
refactoring requires observed evidence rather than symmetry.
