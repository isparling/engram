# engram

A personal, provider-neutral knowledge harness. The core owns the smallest
useful mechanics for capture, reconciliation, approval, retrieval, and
audience-aware presentation, without coupling knowledge to a single host or
domain.

A host agent owns agent execution. This repository owns the durable core: a
CLI (`@isparling/engram-cli`), an OMP extension
(`@isparling/engram-harness`), and the standalone immutable-release manager.

## Core boundaries

| Layer | Responsibility |
| --- | --- |
| Harness | Universal lifecycle, provenance, approval, transactions, retrieval, and presentation receipts |
| Knowledge pack | Reusable domain reasoning, schemas, evidence policy, and view templates |
| Knowledge space | Private durable evidence, claims, subjects, audiences, concrete views, and presentations |
| Local binding | Machine-specific paths, credentials, provider policy, and qmd/session locations |
| Host adapter | Translating one agent's tools, hooks, and session events onto the core interface |

The harness is domain-neutral. Packs are external modules resolved through a
space's binding; the core does not install, configure, bundle, or fall back
between packs. See [harness/docs/pack-interface.md](harness/docs/pack-interface.md).

A single installation may register many knowledge spaces. A host session
binds to one primary space so knowledge, transcripts, and indexes do not
silently mix.

## Packages

- `harness/` — TypeScript core library, CLI entry, OMP extension, and
  property-pinned mutation checker.
- `release/` — standalone immutable-release manager and manifest parser.
- `bin/` — stable `engram` launcher.
- [Release policy](RELEASES.md) — immutable releases, qualification, and
  work-machine consumption contract.
- [Workflow](WORKFLOW.md) — observation-to-release development process.

## Development

Contributions follow the workflow in [WORKFLOW.md](WORKFLOW.md): record an
observed need, reproduce it synthetically, change the smallest coherent
behavior, verify the reproduction, publish an immutable release before using
the change.

Every fixture, example, and reproduction in this repository is synthetic and
fictional. Real work or personal knowledge, paths, transcripts, identifiers,
or credentials are never committed here — including incidental detail.