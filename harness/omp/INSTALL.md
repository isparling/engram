# @isparling/engram-omp — Oh My Pi Extension Install

## Purpose

This extension records knowledge from Oh My Pi sessions into the engram
knowledge system. It is a thin adapter: the pack a space uses is an external
module resolved through the binding's `installed_packs[].from` specifier
(see
[harness/docs/pack-interface.md](https://github.com/isparling/engram/blob/main/harness/docs/pack-interface.md));
the extension only bridges the Oh My Pi host session to the engram CLI.

Two things happen automatically:

1. When a turn ends, the extension extracts knowledge from the turn.
2. The agent can use the `engram_capture` tool to submit knowledge during a
   turn.

## Requirements

- Oh My Pi must be installed.
- `@isparling/engram-omp` and `@isparling/engram-cli` must be installed.
- A valid engram binding registry must exist.
- The project must contain an `engram.space.json` for its registered space, or
  `ENGRAM_SPACE_ID` must name the intended registered space.

## Install the Extension

```sh
npm install @isparling/engram-omp @isparling/engram-harness @isparling/engram-cli
```

Add the extension to your Oh My Pi settings file's `extensions` list:

```
extensions:
  - ./node_modules/@isparling/engram-omp/omp-extension.ts
```

## Set the Environment Variables

The extension reads these variables at session start:

| Variable | Required | Purpose |
|----------|----------|---------|
| `ENGRAM_BINDING_REGISTRY` | Yes | Path to the engram binding registry file |
| `ENGRAM_CLI` | No | Path to the engram CLI binary. Default is `engram` |
| `ENGRAM_SPACE_ID` | No | Overrides the nearest `engram.space.json` space id |

Set `ENGRAM_BINDING_REGISTRY` before you start Oh My Pi. On the first settled
turn of each fresh session, the extension preserves any existing manual
selection; otherwise it selects `ENGRAM_SPACE_ID`, then falls back to the
nearest `engram.space.json`.

Set `ENGRAM_CLI` only if the CLI is not resolvable from the installed
`@isparling/engram-cli` package or from `PATH`.

## How to Start Oh My Pi with the Extension

Use the `--extension` flag:

```sh
omp --extension ./node_modules/@isparling/engram-omp/omp-extension.ts
```

## How to Verify the Extension

1. Start Oh My Pi with the extension.
2. Look for log messages from `[engram]` in the Oh My Pi output.
3. The agent can use the `engram_capture` tool.
4. The agent can also see extracted knowledge after each turn.

## How the Extension Works

### Settled-Turn Extraction

When a main-session turn settles, the extension:

1. Receives OMP's awaited `session_stop` event.
2. Takes only the latest user turn from the accumulated message list.
3. Builds a `TurnContext` with the persisted OMP session id.
4. Loads the active binding's extraction pack.
5. Calls the pack's optional `captureFromTurn(turn, tools)` handler with
   create-only records-root writes and scoped qmd refresh mechanics.
6. Falls back to `engram capture-from-turn` only when the pack exports no
   handler.

### The `engram_capture` Tool

The agent can use the `engram_capture` tool during a turn.

The tool accepts these parameters:

| Parameter | Required | Values |
|-----------|----------|--------|
| `kind` | Yes | `evidence`, `claim`, `interpretation`, `decision`, `recommendation` |
| `statement` | Yes | Free-form text |
| `scope_topics` | No | Array of topic tags |
| `subjects` | No | Array of subject identifiers |

The tool:

1. Builds a knowledge envelope.
2. Writes a temporary file.
3. Calls the engram CLI with `knowledge submit`.
4. Returns the result to the agent.

## Troubleshooting

**The extension does not load.**

- Check that `@isparling/engram-omp` is installed.
- Check that Oh My Pi can resolve the extension path.
- Check that `ENGRAM_BINDING_REGISTRY` is set.

**The `engram_capture` tool returns an error.**

- Check that the engram CLI is installed.
- Check that the binding registry has a valid space.
- Check that the active space declares a resolvable pack.

**Turn-end extraction does not run.**

- Check that the engram CLI is installed and resolvable.
- Check that `ENGRAM_CLI` points to the correct binary, if set.
- Check that the active space declares a pack with extraction support.
