# @isparling/engram-harness

Host-neutral pack and knowledge contracts for the engram knowledge harness.
This package is contract-only: it ships the shared TypeScript interfaces
and enum-like values, but no core transaction runtime, no host adapter,
and no pack implementation. It exists so an external pack and a
host integration can agree on the same interface without depending on each
other's source.

## Quick start

```sh
npm install @isparling/engram-harness
```

```ts
import type { KnowledgePack } from "@isparling/engram-harness/pack-types";
import type { KnowledgeEnvelope } from "@isparling/engram-harness/knowledge-types";
```

A host integration owns translating its own lifecycle events (hooks, tool
calls, session boundaries) onto these contracts, and sends captured
knowledge through the independently installed `engram` CLI
(`@isparling/engram-cli`) rather than importing engram's internal
transaction pipeline. For the Oh My Pi host, that translation already
exists as `@isparling/engram-omp`; see
[harness/omp/README.md](https://github.com/isparling/engram/blob/main/harness/omp/README.md).

## Exports

### `@isparling/engram-harness/pack-types`

The `KnowledgePack` / `PresentationPack` facet surface an external pack
implements, plus the optional `KnowledgeExtractor` interface a pack adds
when it is selected for lifecycle-triggered session capture. See
[docs/pack-interface.md](https://github.com/isparling/engram/blob/main/harness/docs/pack-interface.md)
for the full resolution and failure contract a space's binding relies on.

### `@isparling/engram-harness/knowledge-types`

The knowledge envelope, record, and transaction types shared by every pack
and host integration: `KnowledgeEnvelope`, `KnowledgeRecord`,
`KnowledgeResult`, `HostSessionProvenance`, `TurnContext`, and related
types.

## Scope

This package does not install, configure, bundle, or select a pack — that
is the binding's job (see
[docs/pack-interface.md](https://github.com/isparling/engram/blob/main/harness/docs/pack-interface.md)).
It does not run agent sessions, register tools, or shell out to the CLI
itself; a separately published host adapter package (such as
`@isparling/engram-omp`) does that, using these types to stay compatible
with the core.
