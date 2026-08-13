# Engram OMP Package Split Design

## Goal

Expose the Oh My Pi integration as `@isparling/engram-omp` while preserving `@isparling/engram-harness` as the host-neutral entry point for generic contracts and future agent-host integrations. `@isparling/engram-cli` remains an independent package and is not renamed or modified.

## Decision

Split the current combined package into two published packages:

- `@isparling/engram-harness` remains the generic core-facing package.
- `@isparling/engram-omp` becomes the only package that exports and documents the Oh My Pi extension.

There is no compatibility re-export from `@isparling/engram-harness/omp-extension`. Keeping it would preserve the misleading generic extension identity. Consumers migrate directly to `@isparling/engram-omp`.

## Package Boundaries

### `@isparling/engram-harness`

The existing `harness/` package remains published under its current name. It provides host-neutral public contracts:

- `@isparling/engram-harness/pack-types`
- `@isparling/engram-harness/knowledge-types`

Its manifest and README must describe it as a generic contract package, not as an OMP extension. It must stop exporting `./omp-extension` and `./types`, and it must no longer ship OMP adapter code or OMP-specific documentation.

The generic release builder keeps its private staged runtime package name `engram-harness`. That archive is the generic release-core runtime, not the public Oh My Pi adapter package. The associated release-builder mutation and property test remain unchanged.

No new generic host-adapter abstraction is added. The existing public type modules and the independent CLI are the demonstrated reusable surfaces; the current extension implementation is OMP-specific.

### `@isparling/engram-omp`

Create a sibling package at `harness/omp/` with public npm name `@isparling/engram-omp`.

It owns:

- the moved OMP extension implementation;
- the OMP `ExtensionAPI`, event, context, and tool definitions;
- package-level OMP installation and usage documentation;
- the OMP extension behavior check and its synthetic fixtures as needed.

The default export remains the extension factory currently named `engramExtension`. Its observable OMP behavior remains unchanged: it registers `engram_status`, registers `engram_capture`, and attaches the `agent_end` capture hook.

The adapter may import generic types from `@isparling/engram-harness/knowledge-types` as type-only imports. It must not gain a runtime dependency. It continues to resolve `@isparling/engram-cli/bin/engram` opportunistically and falls back to the configured `ENGRAM_CLI` or `engram` on `PATH`, exactly as today.

## Installation and Migration

The OMP installation command changes from installing `@isparling/engram-harness` to installing `@isparling/engram-omp` together with `@isparling/engram-cli`. Oh My Pi continues loading the extension by filesystem path or through the package export; the physical generic `harness/` directory is not renamed by this change.

All package imports of the OMP adapter change from:

```ts
import engramExtension from "@isparling/engram-harness/omp-extension";
```

to:

```ts
import engramExtension from "@isparling/engram-omp";
```

Generic external-pack imports remain on `@isparling/engram-harness/pack-types` and `@isparling/engram-harness/knowledge-types`.

`@isparling/engram-cli`, its `engram` executable, its source, manifest, README, and release behavior are out of scope.

## Error Handling

The split changes names and package boundaries only. Adapter failure semantics are preserved:

- a missing `ENGRAM_BINDING_REGISTRY` logs a warning and disables capture;
- an explicit `ENGRAM_CLI` takes precedence over package resolution and `PATH`;
- errors at the CLI boundary remain visible through the existing OMP logger and do not create a partial knowledge transaction.

## Verification

Use synthetic fixtures only. Add or update focused package-boundary checks covering these properties:

1. A consumer of `@isparling/engram-harness` can import generic pack and knowledge types, but that package does not export an OMP adapter.
2. A consumer of `@isparling/engram-omp` can import the default adapter and its OMP types.
3. With a synthetic bound space, the OMP adapter still registers both tools and the `agent_end` hook and routes capture through the independent CLI wrapper.
4. Package payload tests prove each public package contains only its own declared distribution surface.

For every changed or new behavior test, first observe it fail with the implementation reverted or absent, then restore the implementation and observe it pass. Run the relevant package test commands and TypeScript checks after the focused proof.