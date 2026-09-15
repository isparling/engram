# @isparling/engram-omp — Specification

## Purpose

The Oh My Pi extension (`harness/omp/omp-extension.ts`, published as
`@isparling/engram-omp`) is the bridge between an Oh My Pi host session and
the engram core. It is a thin adapter: it carries no pack logic itself. All
knowledge operations converge on the engram transaction pipeline through the
engram CLI. The pack surface an external module may implement is defined in
[harness/docs/pack-interface.md](https://github.com/isparling/engram/blob/main/harness/docs/pack-interface.md).

## Factory

```typescript
export default async function engramExtension(api: ExtensionAPI): Promise<void>
```

The extension selects no pack itself. At the awaited final-settle boundary it
uses the active space's binding-selected extraction pack. If that external
module exports `captureFromTurn(turn, tools)`, the extension invokes it and
supplies create-only records-root writes plus scoped qmd refresh mechanics.
The pack owns all draft policy. Modules without the handler retain the generic
`engram capture-from-turn` CLI fallback.

For a fresh OMP session, an existing manual selection wins. Otherwise the
extension selects `ENGRAM_SPACE_ID`, then the nearest `engram.space.json`.
Selection still passes through the registry's validated `space select`
command; the extension never creates or registers a space.

## Behavior

The extension registers three tools and one lifecycle hook:

- **`session_stop` hook** — takes only the latest user turn from the
  accumulated transcript, builds a `TurnContext`, and delegates capture to the
  pack handler or CLI fallback. This hook is awaited by OMP before final
  settlement.
- **`engram_capture_preview({ change_set })`** — hands the pack-defined
  `change_set` to the binding-selected pack's `previewStructuredCapture`. The
  pack builds a candidate envelope and calls back into the host's
  `previewCandidate`, which runs `engram knowledge reconcile` and returns the
  authoritative plan. The extension verifies the pack-declared plan hash
  matches the host's, retains the candidate privately in a
  session-scoped pending-plan map keyed by that hash, and returns only the
  plan hash, the mutation summary (`recordId`/`action` pairs), and the sorted
  artifact paths the pack expects to regenerate. The candidate envelope never
  appears in the tool result.
- **`engram_capture_apply({ plan_hash })`** — commits a previously previewed
  plan. Unknown or session-mismatched hashes are rejected without invoking
  the CLI. A pending plan is approved via
  `engram knowledge approve --candidate <file> --expect <plan_hash>` against
  the exact retained candidate; a stale approval deletes the pending entry
  and requires a fresh preview. On commit or no-change, the applied mutation
  view is handed to the pack's `materialize`, which regenerates compatibility
  views through `listRecords`/`replaceArtifact` host mechanics. If
  materialization fails, the committed records are retained under
  `records-committed`; a second apply with the same hash retries only
  materialization and never re-runs `knowledge approve`.
- **`engram_status` tool** — reports the designated extraction pack id/version,
  `mode: "cli"`, the session's pending plan hashes, the last known qmd index
  state, and any artifacts that failed to regenerate.

## Host runtime

Bun is the only runtime the extension requires. Oh My Pi installs npm plugins
with `bun install` and imports extension modules with Bun, so the adapter
resolves both its CLI (`@isparling/engram-cli`, a runtime dependency) and the
binding's bare `installed_packs[].from` specifiers through a `bun` subprocess
calling `Bun.resolveSync`, anchored at the adapter's own package directory.

Two host constraints make that the only portable resolution: Oh My Pi
sanitizes the extension `PATH`, so a Node interpreter is not reachable on an
ordinary version-managed machine, and plugin modules load through a virtual
resolver whose in-process `import.meta.resolve`, `Bun.resolveSync`, and
`createRequire(...).resolve` cannot see sibling installed packages. Resolution
must therefore depend on neither `node` nor in-process specifier lookup. The
headless extraction child is likewise restricted to flags the installed Oh My
Pi accepts (`--no-session --no-extensions --no-skills --no-rules`); an
unsupported isolation flag makes every ambient completion exit non-zero and
silently produces no drafts.

## Reason

The extension owns only host mechanics: settled-turn normalization,
binding-declared module loading, records-root confinement, create-only writes,
scoped qmd refresh, temporary-file confinement for candidates and generated
artifacts, and plan-hash verification. Domain policy — including whether and
how observations become drafts, and what a change set means — lives in the
pack. Core transaction, retrieval, and presentation behavior remains
unchanged; the adapter never interprets record roles, entity keys, artifact
kinds, or pack-owned output shape.

## Out of scope

- The extension does not configure, bundle, select, or fall back between
  packs. The active space binding selects the extraction pack.
- View, audience, delivery, and draft-promotion policy live outside the
  extension.
