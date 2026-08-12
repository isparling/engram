# @isparling/engram-harness

Generic OMP extension for structured knowledge capture. This package is a
core-only artifact: it carries no pack logic. Packs are external modules a
space's binding resolves through `installed_packs[].from`; the interface they
implement is documented in
[harness/docs/pack-interface.md](https://github.com/isparling/engram/blob/main/harness/docs/pack-interface.md).
Load the extension runtime; it shells out to the `@isparling/engram-cli`
binary for every pack operation.

## Quick start

```sh
npm install @isparling/engram-harness @isparling/engram-cli
```

```ts
// my-extension.ts
import engramExtension, { type ExtensionAPI } from "@isparling/engram-harness/omp-extension";

export default async function (api: ExtensionAPI) {
  return engramExtension(api);
}
```

```sh
omp --extension ./my-extension.ts
```

The extension resolves every pack through the active binding registry and
delegates capture and submission entirely to the engram CLI.

## API

### `engramExtension(api)`

Default export. Registers the `engram_status` and `engram_capture` tools and an
`agent_end` hook against the supplied `api`, returning a promise that resolves
once the extension is set up.

- `api` — the OMP extension API surface (see `ExtensionAPI`).

Pack implementations are external Node ESM modules selected by
`installed_packs[].from` in the active local binding; see
[`docs/pack-interface.md`](https://github.com/isparling/engram/blob/main/harness/docs/pack-interface.md).

### `ExtensionAPI`

```ts
interface ExtensionAPI {
  on(event: "agent_end", handler: (event, ctx) => void | Promise<void>): void;
  registerTool(tool: ToolDefinition): void;
  logger: { info(message: string): void; warn(message: string): void };
}
```

### `engram_status` tool

Reports the designated extraction pack (declared with `extract: true`) after
an `agent_end` hook has resolved the session. It always reports `mode: "cli"`.

### `engram_capture` tool

Submits a structured knowledge observation from the current session through the
binding-selected CLI transaction pipeline.

## Configuration

| Variable | Purpose |
|----------|---------|
| `ENGRAM_CLI` | Path to the engram CLI binary. Default: the `@isparling/engram-cli` package when installed, else `engram` on PATH. |
| `ENGRAM_BINDING_REGISTRY` | Path to the binding registry. Required for knowledge capture; capture is disabled with a warning when unset. |

The extension logs only CLI-boundary failures. It never loads an in-memory pack.
