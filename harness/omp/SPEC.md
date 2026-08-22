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

## Behavior

The extension registers two tools and one lifecycle hook:

- **`session_stop` hook** — takes only the latest user turn from the
  accumulated transcript, builds a `TurnContext`, and delegates capture to the
  pack handler or CLI fallback. This hook is awaited by OMP before final
  settlement.
- **`engram_capture` tool** — the agent supplies a structured
  kind/statement/topics envelope, which is written to a temporary file and
  submitted via `engram knowledge submit`.
- **`engram_status` tool** — reports the designated extraction pack id/version
  after session resolution and always reports `mode: "cli"`.

## Reason

The extension owns only host mechanics: settled-turn normalization,
binding-declared module loading, records-root confinement, create-only writes,
and scoped qmd refresh. Domain policy — including whether and how observations
become drafts — lives in the pack. Core transaction, retrieval, and
presentation behavior remains unchanged.

## Out of scope

- The extension does not configure, bundle, select, or fall back between
  packs. The active space binding selects the extraction pack.
- View, audience, delivery, and draft-promotion policy live outside the
  extension.
