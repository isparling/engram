# External Pack Interface

## Purpose

The core is host-neutral and domain-neutral. An external pack supplies the
domain judgment the core deliberately does not have: extraction guidance,
schemas, reconciliation policy, approval policy, views, and audiences. A
space's binding declares the packs that may operate on it through
`installed_packs[]`; the core resolves each declared pack as an ordinary
Node ESM module at the `from` specifier and never ships, installs, or
selects a pack itself.

## Published type imports

A pack module imports the interface types the core publishes:

- `@isparling/engram-harness/knowledge-types` — knowledge envelope, record,
  proposal, and transaction types.
- `@isparling/engram-harness/pack-types` — the `KnowledgePack` /
  `PresentationPack` facet surface a pack implements.

The pack's exported object must implement both `KnowledgePack` and
`PresentationPack`: `id`, `version`, envelope validation, related-query
construction, reconciliation, retrieval policy, views, audiences, and
deliveries. The loader validates this complete surface before returning it.

`KnowledgeExtractor` is the only optional interface. A pack that is selected
for `agent_end` capture additionally implements it; normal knowledge and
presentation operations do not accept a partial pack.

## Binding declaration

A space's binding lists required packs:

```json
{
  "installed_packs": [
    { "id": "example-pack", "version": "0.1.0", "from": "example-pack" }
  ]
}
```

- `installed_packs` is a non-empty array. Every entry has `id` and `version`;
  it may also have a non-empty `from` module specifier and an `extract` boolean.
- `from` is imported once as a Node ESM module. A package name resolves through
  normal Node resolution; `./` and `../` paths resolve relative to the local
  binding file that declares them. It is never interpreted as a bundled or
  built-in pack.
- The pack's exported `id` and `version` must equal the binding declaration
  (`pack_identity_mismatch` otherwise).

## Resolution and failure semantics

Resolution is exactly one Node ESM import of the declared `from` specifier,
followed by a shape check of the exported value. There is no registry, no
version negotiation, and no fallback between packs. A failed resolution is a
validation failure with exactly one of four categories:

- `pack_from_required` — the binding entry omits `from`.
- `pack_load_failed` — the module cannot be imported (missing package, bad
  specifier, or a thrown import error).
- `pack_export_invalid` — the module loads but does not export a well-formed
  pack object.
- `pack_identity_mismatch` — the exported `id`/`version` differ from the
  binding declaration.

A refusal never substitutes another pack and never proceeds with a partial
resolution.

## Pack-owned configuration

A pack's configuration lives in the pack instance and in the space's
binding, never in core code. The core does not install a pack, configure a
pack, bundle a pack, or fall back between packs: all three are the
integrator's job, and the core fails closed when any part of the declaration
is absent or unloadable.

## Compatibility

The core pins the pack API at a single compatibility version
(`pack_api_compatibility: 0`). A pack that targets a different API version is
refused. Packs cannot weaken core authorization, transaction, provenance, or
receipt invariants: core guards run regardless of pack behavior.
