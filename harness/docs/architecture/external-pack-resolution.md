# External pack resolution

`resolveKnowledgePack` in `harness/src/packLoader.ts` resolves a pack's
declared `id` + `version` by importing the binding's `installed_packs[].from`
module specifier with a single Node ESM `import()`. Resolution is explicit
and external-only: the core never ships a pack, never consults a bundled
registry, and never substitutes a default when a declared pack cannot be
resolved.

## Resolution

1. The binding entry must declare a non-empty `from` specifier. A required
   pack that omits `from` fails closed as `pack_from_required`.
2. The core imports the module at `from` exactly once. An import failure —
   missing package, bad specifier, or a thrown module error — is reported as
   `pack_load_failed`.
3. The imported value must be a well-formed pack export (an object with
   `id` and `version` and valid facet shapes). A malformed export is
   reported as `pack_export_invalid`.
4. The exported `id` and `version` must equal the binding declaration.
   A mismatch is reported as `pack_identity_mismatch`.

Every failure is a `kind: "validation"` error with exactly one of those four
categories. Messages describe the category and never print module contents,
local paths, or an imported exception stack.

## Call sites

Both `resolveCliPack` (the `knowledge submit` path) and the
`capture-from-turn` fallback use the shared resolver. The `findExport` helper
lives in `packLoader.ts`.

## Property test

`harness/test/packResolution.test.ts` — "property: knowledge submit with
external pack via from field resolves the pack rather than pack_unknown".
Observed failure cycle via revert: write test → revert the declared-`from`
pass-through → test fails with `pack_unknown` → restore → test passes.

Fixture: `harness/test/packLoader.fixture.ts` exports `externalDemo` (a
`KnowledgePack & PresentationPack`), matched by `camelToSnake("external-demo")`.

## Mutation

`harness/mutations.ts` — `loader-pack-external-from-resolved` mutates the
`pack_identity_mismatch` refusal in `resolveKnowledgePack`, pinning that the
declared `from` is what gets imported.
