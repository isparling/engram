# OMP Extension — Specification

## Purpose

The omp extension (`harness/omp-extension.ts`) is the bridge between an omp
host session and the engram core. It is a core-only artifact: it carries no
pack logic itself. All knowledge operations converge on the engram transaction
pipeline through the engram CLI. The pack surface an external module may
implement is defined in [harness/docs/pack-interface.md](docs/pack-interface.md).

## Factory

```typescript
export default async function engramExtension(api: ExtensionAPI): Promise<void>
```

The extension imports no pack implementation. Every pack is resolved by the
CLI from the active binding's `installed_packs[].from` entry; the extension
never selects or invokes an in-memory pack object.

## Behavior

The extension registers two tools and one lifecycle hook:

- **`agent_end` hook** — builds a `TurnContext` from the settled turn and
  sends it to `engram capture-from-turn`, so extracted knowledge reaches the
  transaction pipeline.
- **`engram_capture` tool** — the agent supplies a structured
  kind/statement/topics envelope, which is written to a temporary file and
  submitted via `engram knowledge submit`.
- **`engram_status` tool** — reports the designated extraction pack id/version
  after session resolution and always reports `mode: "cli"`.

## Reason

The extension stays thin by design. It normalizes omp events and shells out
to the engram CLI for pack operations, avoiding import-resolution coupling
between omp's extension runtime and the core's module layout.

## Out of scope

- The extension does not configure, bundle, select, or fall back between packs.
  The CLI resolves every pack from the active space binding's
  `installed_packs[].from` entry.
- View, audience, and delivery logic lives in the core transaction pipeline,
  not in the extension.