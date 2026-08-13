# Engram OMP Package Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the Oh My Pi adapter as `@isparling/engram-omp` while retaining `@isparling/engram-harness` as the host-neutral package for generic contracts.

**Architecture:** Move the thin OMP adapter and its OMP-only API types into a sibling `harness/omp/` package. The generic `harness/` package retains only public pack and knowledge types; the adapter consumes the knowledge types through a type-only import and shells out to the unchanged independent `engram` CLI. The immutable release runtime remains generic and keeps its existing private `engram-harness` staging metadata.

**Tech Stack:** TypeScript ESM, Node built-in test runner with type stripping, Bun test runner, npm package payload inspection.

## Global Constraints

- Use only synthetic fixtures; never add private content, paths, logs, or credentials.
- `@isparling/engram-cli`, its manifest, source, README, `engram` executable, and release behavior are out of scope.
- `@isparling/engram-harness` has zero runtime dependencies; `@isparling/engram-omp` must have no `dependencies` entry and must import generic contracts only with `import type`.
- Do not edit governing documents: `VISION.md`, `KNOWLEDGE_MODEL.md`, `ARCHITECTURE.md`, `PRODUCT_CONTRACT.md`, or `OPERATING_CONSTRAINTS.md`.
- Clean cutover: `@isparling/engram-harness/omp-extension` and `@isparling/engram-harness/types` are removed; do not leave compatibility re-exports.
- Preserve the staged release runtime metadata `{"name":"engram-harness","private":true,"type":"module"}` and its mutation/property checks; it names the generic release core, not the OMP package.
- Every changed-property test must be observed failing before the implementation that makes it pass is restored.

---

### Task 1: Split the published OMP adapter package

**Files:**
- Create: `harness/omp/package.json`
- Create: `harness/omp/README.md`
- Create: `harness/omp/LICENSE`
- Create: `harness/omp/omp-extension.ts`
- Create: `harness/omp/ompExtension.check.ts`
- Create: `harness/test/ompPackage.test.ts`
- Modify: `harness/package.json:2-38`
- Modify: `harness/tsconfig.json:2-13`
- Delete: `harness/omp-extension.ts`
- Delete: `harness/ompExtension.check.ts`

**Interfaces:**
- Consumes: `@isparling/engram-harness/knowledge-types` type exports `HostSessionProvenance`, `TurnContext`, and `TurnToolCall`; `@isparling/engram-cli/bin/engram` remains an optional runtime resolution target.
- Produces: `@isparling/engram-omp` default export `engramExtension(api: ExtensionAPI): Promise<void>` and named OMP-only types `ExtensionAPI`, `AgentEndEvent`, `ExtensionContext`, and `ToolDefinition`.
- Preserves: `engram_status`, `engram_capture`, and the `agent_end` hook behavior; generic public imports remain `@isparling/engram-harness/pack-types` and `@isparling/engram-harness/knowledge-types`.

- [ ] **Step 1: Write the package-boundary property tests**

Create `harness/test/ompPackage.test.ts`. Parse each manifest with concrete structural types, obtain `npm pack --json --dry-run` inventories, and test both package boundaries:

```ts
type ExportTarget = { import: string };
type PackageManifest = {
  name: string;
  exports: Record<string, ExportTarget | undefined>;
  dependencies?: Record<string, string>;
};

function requireExport(manifest: PackageManifest, key: string): ExportTarget {
  const target = manifest.exports[key];
  assert.ok(target !== undefined, `missing export ${key}`);
  return target;
}

test("property: generic harness package exports generic contracts but no OMP adapter", async () => {
  const manifest = await readPackageJson(harness);
  assert.equal(manifest.name, "@isparling/engram-harness");
  assert.equal(manifest.exports["./omp-extension"], undefined);
  assert.equal(manifest.exports["./types"], undefined);
  assert.equal(requireExport(manifest, "./pack-types").import, "./src/packTypes.ts");
  assert.equal(requireExport(manifest, "./knowledge-types").import, "./src/knowledgeTypes.ts");
  assert.equal((await packPaths(harness)).includes("omp-extension.ts"), false);
});

test("property: OMP package payload contains only the OMP adapter distribution surface", async () => {
  const manifest = await readPackageJson(omp);
  assert.equal(manifest.name, "@isparling/engram-omp");
  assert.equal(requireExport(manifest, ".").import, "./omp-extension.ts");
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(await packPaths(omp), ["LICENSE", "README.md", "omp-extension.ts", "package.json"]);
});
```

`readPackageJson` must parse `JSON.parse` as `unknown` and validate the object, `name`, `exports`, and every export target before returning `PackageManifest`; do not use `as any`, `as unknown as`, or non-null assertions. `packPaths` must parse the npm JSON inventory as `unknown`, validate each `files[].path` string, and return sorted paths.
Copy the existing `harness/ompExtension.check.ts` to `harness/omp/ompExtension.check.ts` and update only its local paths and imports:

```ts
import engramExtension, {
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "./omp-extension.ts";
import { registerSpace, selectSpace } from "../src/spaceRegistry.ts";
import { createUninitializedEphemeralSpace, destroyEphemeralSpace, type EphemeralSpace } from "../test/testSupport.ts";
```

Make `SPACE_A_RECORDS_DIR`, `CLI_PATH`, and `FIXTURE_PATH` resolve through the parent `harness/` directory. Retain the existing property name and all synthetic binding, wrapper, registration, hook, and tool assertions.

- [ ] **Step 2: Run the new tests and observe the missing OMP package fail**

Run from `harness/`:

```sh
node --test --experimental-strip-types test/ompPackage.test.ts
bun test ./omp/ompExtension.check.ts
```

Expected: the package-boundary test fails because `omp/package.json` does not exist; the moved behavior check fails because `omp/omp-extension.ts` does not exist. Record both failures before creating the package.

- [ ] **Step 3: Move the adapter into its OMP-only package**

Move `harness/omp-extension.ts` to `harness/omp/omp-extension.ts`. Preserve all runtime code and the default export. Change its only generic import to a type-only public-package import:

```ts
import type { HostSessionProvenance, TurnContext, TurnToolCall } from "@isparling/engram-harness/knowledge-types";
```

Update the module header and CLI-resolution comment to say “Oh My Pi” and identify the adapter package as `@isparling/engram-omp`; do not change `resolveCliPath`, its `ENGRAM_CLI` precedence, or the `@isparling/engram-cli/bin/engram` resolution target.

Create `harness/omp/package.json`:

```json
{
  "name": "@isparling/engram-omp",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "license": "Apache-2.0",
  "description": "Oh My Pi extension for Engram knowledge capture.",
  "exports": {
    ".": { "import": "./omp-extension.ts" },
    "./types": { "import": "./omp-extension.ts" }
  },
  "files": ["omp-extension.ts", "README.md"],
  "peerDependencies": {
    "@isparling/engram-harness": "^0.1.0"
  },
  "publishConfig": { "access": "public" }
}
```

Create `harness/omp/README.md` with this initial package contract so the first publishable payload is usable:

```markdown
# @isparling/engram-omp

Oh My Pi extension for Engram knowledge capture. It translates Oh My Pi lifecycle events into calls to the independently installed `engram` CLI; it contains no pack implementation or private knowledge.

Install `@isparling/engram-omp`, `@isparling/engram-harness`, and `@isparling/engram-cli`. Import the default export from `@isparling/engram-omp` to register the extension against an Oh My Pi `ExtensionAPI`.
```

Copy the Apache-2.0 text from `harness/LICENSE` into `harness/omp/LICENSE`. npm includes that standard license file automatically even when it is not listed in `files`.

Update `harness/package.json` so its public description is host-neutral, remove the `.` and `./omp-extension` / `./types` entries that point to the OMP source, retain `./pack-types` and `./knowledge-types`, and remove `omp-extension.ts` from its `files` list. Do not modify `harness/package-lock.json`: it already correctly names the retained generic package `@isparling/engram-harness`.

Extend `harness/tsconfig.json` with the OMP package source and test paths plus a typecheck-only mapping:

```json
"baseUrl": ".",
"paths": {
  "@isparling/engram-harness/knowledge-types": ["src/knowledgeTypes.ts"]
},
"include": ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "omp/**/*.ts", "mutations.ts", "../release/**/*.ts"]
```

Update the root harness test script to run `bun test ./omp/ompExtension.check.ts` instead of the deleted check. Delete the old OMP source and check after the move; do not leave copies.

- [ ] **Step 4: Run the focused package and behavior tests and observe them pass**

Run from `harness/`:

```sh
node --test --experimental-strip-types test/ompPackage.test.ts
bun test ./omp/ompExtension.check.ts
tsc --noEmit -p tsconfig.json
```

Expected: both package-boundary properties pass; the synthetic OMP behavior property still registers the hook and tool, resolves the external pack through `from`, and submits through the CLI wrapper; TypeScript resolves the type-only generic contract import without an unsafe assertion.

- [ ] **Step 5: Commit the package split**

```sh
git add harness/package.json harness/tsconfig.json \
  harness/omp harness/test/ompPackage.test.ts \
  harness/omp-extension.ts harness/ompExtension.check.ts
git commit -m "feat: publish Oh My Pi adapter separately"
```

### Task 2: Cut documentation over to the correct package boundary

**Files:**
- Modify: `README.md:9-10`
- Modify: `harness/README.md:1-74`
- Create: `harness/omp/INSTALL.md`
- Create: `harness/omp/SPEC.md`
- Modify: `harness/docs/pack-interface.md:16-20` only if an import path no longer matches the retained generic package exports
- Delete: `harness/omp-extension-INSTALL.md`
- Delete: `harness/omp-extension-SPEC.md`

**Interfaces:**
- Consumes: package names and exports produced by Task 1.
- Produces: documentation that directs generic integrations to `@isparling/engram-harness` contracts and directs Oh My Pi users to `@isparling/engram-omp`.
- Preserves: all `@isparling/engram-cli` documentation and files unchanged.

- [ ] **Step 1: Update the generic and root package descriptions**

Change root `README.md` to list three roles: the independent `@isparling/engram-cli`, host-neutral `@isparling/engram-harness` contracts, and the separate `@isparling/engram-omp` Oh My Pi adapter.

Rewrite `harness/README.md` around the generic contract boundary. Its example must import only retained exports, for example:

```ts
import type { KnowledgePack } from "@isparling/engram-harness/pack-types";
import type { KnowledgeEnvelope } from "@isparling/engram-harness/knowledge-types";
```

State that a host integration owns host lifecycle translation and sends work through the independently installed `engram` CLI. Do not expose or mention the removed OMP export there.

Leave `harness/docs/pack-interface.md` on its existing generic type import paths. Change it only if Task 1 changed those exports; otherwise its current paths are the intended host-neutral public API.

- [ ] **Step 2: Create OMP-specific install and behavior documentation**

Create `harness/omp/INSTALL.md` from the existing OMP installation instructions, changing all package/import examples to the adapter package and naming Oh My Pi in prose:

```sh
npm install @isparling/engram-omp @isparling/engram-harness @isparling/engram-cli
omp --extension ./node_modules/@isparling/engram-omp/omp-extension.ts
```

Document `ENGRAM_BINDING_REGISTRY` and optional `ENGRAM_CLI` exactly as before. Preserve the tool names, `agent_end` capture behavior, and failure diagnostics.

Create `harness/omp/SPEC.md` from the existing extension specification. Change only physical/package paths and host naming: `harness/omp/omp-extension.ts`, `@isparling/engram-omp`, and “Oh My Pi.” Preserve its core-only, external-pack, and thin-adapter constraints.

Update `harness/omp/README.md` to link to `INSTALL.md` and `SPEC.md`, show the `@isparling/engram-omp` import, and state that the independent CLI is required for normal capture.

Delete the two obsolete top-level OMP documents after their content has moved. Do not alter `harness/cli/README.md` or `harness/cli/package.json`.

- [ ] **Step 3: Verify all user-facing package paths resolve to the intended owner**

Run from `harness/`:

```sh
node --test --experimental-strip-types test/ompPackage.test.ts
npm pack --json --dry-run
npm pack --json --dry-run --prefix omp
```

Expected: the generic package payload does not ship the OMP adapter; the OMP package payload ships its adapter source, README, and license; package documentation contains no `@isparling/engram-harness/omp-extension` import.

- [ ] **Step 4: Commit the documentation cutover**

```sh
git add README.md harness/README.md harness/omp harness/docs/pack-interface.md \
  harness/omp-extension-INSTALL.md harness/omp-extension-SPEC.md
git commit -m "docs: separate generic and Oh My Pi integrations"
```

### Task 3: Verify the full split and release-core invariants

**Files:**
- Modify only if verification exposes a real defect in a Task 1 or Task 2 file.
- Do not modify: `harness/cli/**`, `harness/scripts/release-builder.ts`, `harness/test/releaseBuilder.test.ts`, `harness/mutations.ts`.

**Interfaces:**
- Consumes: the package split and migrated documentation from Tasks 1–2.
- Proves: generic release-core metadata remains generic, generic package payload contains no OMP adapter, and the OMP adapter preserves its synthetic capture behavior.

- [ ] **Step 1: Run the complete harness contract suite**

Run from `harness/`:

```sh
npm test
npm run typecheck
```

Expected: Node contract tests, the relocated Bun OMP behavior check, and TypeScript compilation pass. The test run must include the existing release-builder property that requires the staged runtime package JSON to remain exactly `engram-harness` with its three approved keys.

- [ ] **Step 2: Smoke-test both publishable payloads**

Run from `harness/`:

```sh
npm pack --json --dry-run
npm pack --json --dry-run --prefix omp
```

Inspect the JSON inventories. Expected generic payload: public generic type source and generic README/license, without `omp-extension.ts`. Expected OMP payload: `omp-extension.ts`, `README.md`, `LICENSE`, and `package.json`, without generic CLI or core source trees.

- [ ] **Step 3: Commit only any verification-driven correction**

If and only if a verification failure required a correction:

```sh
git add <corrected-files>
git commit -m "fix: complete OMP package split"
```

Otherwise create no empty commit. Report the exact failing-before-passing evidence from Task 1 and the full-suite/payload outputs from this task.