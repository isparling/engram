# @isparling/engram-omp

Oh My Pi extension for Engram knowledge capture. It translates Oh My Pi
lifecycle events into calls to the independently installed `engram` CLI; it
contains no pack implementation or private knowledge.

```sh
npm install @isparling/engram-omp @isparling/engram-harness @isparling/engram-cli
```

```ts
import engramExtension from "@isparling/engram-omp";
```

The independently installed `@isparling/engram-cli` is required for normal
knowledge capture: the extension shells out to it for both turn-end
extraction and the `engram_capture` tool, and does not perform any
transaction work itself.

- [INSTALL.md](https://github.com/isparling/engram/blob/main/harness/omp/INSTALL.md) — installing and configuring the extension.
- [SPEC.md](https://github.com/isparling/engram/blob/main/harness/omp/SPEC.md) — extension behavior and scope.
