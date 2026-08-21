# @isparling/engram-cli

The CLI binary backing Engram's knowledge submission pipeline for host
integrations such as `@isparling/engram-omp`. It resolves knowledge submissions,
reconciliations, rollups, recall queries, and rendered outputs against a
configured binding registry. The CLI is a core-only artifact: packs are
external modules resolved through the binding's `installed_packs[].from`
specifier (see
[harness/docs/pack-interface.md](https://github.com/isparling/engram/blob/main/harness/docs/pack-interface.md)).

## Usage

```
engram knowledge submit --candidate <path>
engram knowledge reconcile --candidate <path>
engram knowledge approve|reject --candidate <path> --expect <plan_hash>
engram rollup preview --bullets <path>
engram rollup approve --bullets <path> --expect <rollup-hash>
engram space register --binding <path>
engram space select <space-id>
engram space status
engram recall --query <text> --audience <id> [--source-class <class>]
engram render --view <id> --audience <id> --delivery <id> --model <provider/model>
```

Run `engram --help` for current command usage.

## Requirements

Requires [Bun](https://bun.sh) to run. Install:

```sh
curl -fsSL https://bun.sh/install | bash
```

## Configuration

| Variable | Required | Purpose |
|----------|----------|---------|
| `ENGRAM_BINDING_REGISTRY` | required | Path to the engram binding registry (space bindings). |
| `ENGRAM_HOST_SESSION_ID` | for session-scoped ops | Identifies the host session for provenance-stamped operations. |
