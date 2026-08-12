# OMP Extension for engram Knowledge Capture

## Purpose

This extension records knowledge from OMP sessions into the engram knowledge
system. It is a core-only artifact: the pack a space uses is an external
module resolved through the binding's `installed_packs[].from` specifier (see
[harness/docs/pack-interface.md](docs/pack-interface.md)); the extension only
bridges the host session to the engram CLI.

Two things happen automatically:

1. When a turn ends, the extension extracts knowledge from the turn.
2. The agent can use the `engram_capture` tool to submit knowledge during a
   turn.

## Requirements

- OMP must be installed.
- The engram harness must be in a known location on your machine.
- A valid engram binding registry must exist.

## Install the Extension

1. Open the OMP settings file.
2. Add the extension path to the `extensions` list:

   ```
   extensions:
     - /path/to/engram/harness/omp-extension.ts
   ```

   Replace `/path/to/engram/` with the real path on your machine.

3. Save the settings file.

## Set the Environment Variables

The extension reads these variables at session start:

| Variable | Required | Purpose |
|----------|----------|---------|
| `ENGRAM_BINDING_REGISTRY` | Yes | Path to the engram binding registry file |
| `ENGRAM_CLI` | No | Path to the engram CLI binary. Default is `engram` |

Set `ENGRAM_BINDING_REGISTRY` before you start OMP.

You can also set `ENGRAM_CLI` if the CLI is not in your PATH.

## How to Start OMP with the Extension

Use the `--extension` flag:

```
omp --extension /path/to/engram/harness/omp-extension.ts
```

## How to Verify the Extension

1. Start OMP with the extension.
2. Look for log messages from `[engram]` in the OMP output.
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

- Check that the file path is correct.
- Check that OMP can read the file.
- Check that `ENGRAM_BINDING_REGISTRY` is set.

**The `engram_capture` tool returns an error.**

- Check that the engram CLI is installed.
- Check that the binding registry has a valid space.
- Check that the active space declares a resolvable pack.

**Turn-end extraction does not run.**

- Check that the engram CLI is in the PATH.
- Check that `ENGRAM_CLI` points to the correct binary.
- Check that the active space declares a pack with extraction support.