# Release Contract

Personal and work machines consume immutable harness releases. Knowledge
spaces, machine-local bindings, derived indexes, and private session data
remain outside the release artifact.

This document defines what counts as a release before a packaging tool or
distribution channel has been selected.

## Required properties

A release is:

- **versioned** — it has a unique, stable identifier;
- **traceable** — it identifies the exact source revision;
- **immutable** — published contents are never replaced under the same version;
- **verifiable** — the validations used to qualify it are recorded;
- **compatible** — relevant host agent, qmd, schema, and pack expectations are stated;
- **installable** — consumption does not require a development checkout;
- **reversible** — a previous compatible release can be selected when rollback is
  needed;
- **content-free** — it contains no user, employer, or family knowledge.

A branch, uncommitted directory, local archive with no provenance, or `main` at an
unspecified time is not a release.

## Release boundary

A release contains only:

- the host-neutral harness library and CLI;
- host adapters that are part of the core artifact, such as an OMP extension;
- schemas, validators, migrations, and synthetic examples;
- installation and compatibility metadata;
- benchmarks that use synthetic data.

A release must not contain:

- knowledge-space contents or Git history from those spaces;
- machine-local bindings, absolute paths, provider credentials, or organization
  configuration;
- qmd indexes, caches, embeddings, session transcripts, presentations, or receipts;
- work-derived examples, even if they appear sanitized;
- external pack modules or their configuration.

External knowledge repositories are never submodules or build inputs of this
repository.

## Minimum release metadata

Every release must carry or accompany:

```text
Version:
Source revision:
Build or packaging procedure version:
Host agent compatibility:
qmd compatibility:
Knowledge schema compatibility:
Pack API compatibility:
Environment compatibility:
Included packs: always empty for the core artifact;
Verification summary:
Known limitations:
Artifact integrity value:
Published at:
```

The integrity value is a checksum. Signing policy follows the active transport
and threat model.

## Qualification

Before publishing:

1. start from a known source revision;
2. run the reproduction and focused checks for every included change;
3. run the repository's required synthetic benchmark set;
4. exercise transaction rollback, explicit space binding, and cross-space denial;
5. inspect packaged contents for secrets, private data, development files, and
   unintended dependencies;
6. exercise installation and rollback in a clean, representative environment;
7. record compatibility and known limitations;
8. generate the immutable artifact and integrity value.

The release record states which checks were manual. A verification step with no
subject is recorded honestly as `not_applicable` with a matching known
limitation rather than fabricating a result or quietly dropping the step.

## Installation and local binding

Installation places only the released harness on a machine. An integrator-owned,
machine-local binding selects:

- which knowledge spaces are available;
- where each space is stored;
- which external module bindings may operate on each space;
- which host agent, providers, and tools are allowed;
- which qmd collection or index belongs to each space.

The integrator acquires and configures external modules. The core imports only
the explicit `from` specifiers declared by the binding.

Bindings are never silently generated from nearby repositories and are never included
in the product release. A session has one primary space. Switching primary spaces
requires a fresh session.

Upgrades may validate or propose changes to a binding or space schema, but they must
not silently migrate private knowledge. A migration is explicit, reviewable, backed
up, and attributable to a release.

## Work-machine rules

A work machine may:

- obtain a release through an approved distribution path;
- verify its identity or integrity;
- install, select, run, and roll back a release;
- bind it to an organization-owned knowledge repository and approved enterprise
  providers;
- produce a manually reviewed, content-free observation under
  [WORKFLOW.md](WORKFLOW.md).

A work machine must not:

- clone the personal development repository as its installation method;
- build from or track a mutable development branch;
- edit installed harness behavior in place;
- bind personal and work knowledge into the same space;
- send source, credentials, sessions, summaries, knowledge records, or proprietary
  payloads to the personal development environment.

There is no automatic telemetry from work. Machine-specific policy may narrow this
contract further.

## Failure and rollback

When a release fails:

1. identify the installed version and active binding;
2. stop a transaction if its integrity is uncertain;
3. restore from the transaction backup or roll back to a compatible release as
   appropriate;
4. record the observation in the environment where it occurred;
5. export only a permitted work observation, when applicable;
6. reproduce and fix the product with synthetic or personal data;
7. publish a new version.

Never mutate the failed artifact. A corrected artifact receives a new version, even
when the code change is small.

## Pack compatibility

A release contains no pack modules. An integrator supplies external modules
through explicit binding declarations, and each module declares the harness API
and knowledge-schema ranges it expects. The harness rejects incompatible modules
before they can write a space.

External module updates cannot weaken harness authorization, transaction,
provenance, or receipt invariants.

## Deployment policy

Transport, signing, update checks, and installation automation are deployment
policy. This contract records the release invariants; active deployment choices
belong in [OPERATING_CONSTRAINTS.md](OPERATING_CONSTRAINTS.md).