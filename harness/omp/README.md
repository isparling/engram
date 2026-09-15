# @isparling/engram-omp

Oh My Pi extension for Engram knowledge capture. It translates Oh My Pi
lifecycle events into calls to its packaged `@isparling/engram-cli` runtime
dependency; it contains no pack implementation or private knowledge.

```sh
omp install @isparling/engram-omp
```

```ts
import engramExtension from "@isparling/engram-omp";
```

`@isparling/engram-cli` installs automatically with the adapter. The extension
shells out to that package for turn-end extraction and for the two hash-bound
`engram_capture_preview` / `engram_capture_apply` tools; it does not perform
transaction work itself.

- [INSTALL.md](https://github.com/isparling/engram/blob/main/harness/omp/INSTALL.md) — installing and configuring the extension.
- [SPEC.md](https://github.com/isparling/engram/blob/main/harness/omp/SPEC.md) — extension behavior and scope.
