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

Set `ENGRAM_BINDING_REGISTRY` before you start Oh My Pi.

You can also set `ENGRAM_CLI` if the CLI is not resolvable from the
installed `@isparling/engram-cli` package or from your PATH.

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

### Turn-End Extraction

When a turn completes, the extension:

1. Reads the turn messages.
2. Builds a turn context.
3. Calls the engram CLI with `capture-from-turn`.
4. The CLI resolves the active space's declared pack and extracts knowledge
   from the turn, then submits it.

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
