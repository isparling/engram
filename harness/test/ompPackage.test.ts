import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url)); // harness/test
const harness = resolve(here, ".."); // harness
const omp = join(harness, "omp");

type ExportTarget = { import: string };
type PackageManifest = {
  name: string;
  exports: Record<string, ExportTarget | undefined>;
  dependencies?: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExportTarget(value: unknown, key: string): ExportTarget {
  if (!isRecord(value)) throw new Error(`package.json export "${key}" is not an object`);
  const importPath = value.import;
  if (typeof importPath !== "string") throw new Error(`package.json export "${key}" is missing a string "import"`);
  return { import: importPath };
}

function parseExports(value: unknown): Record<string, ExportTarget | undefined> {
  if (!isRecord(value)) throw new Error('package.json "exports" is not an object');
  const exports: Record<string, ExportTarget | undefined> = {};
  for (const [key, target] of Object.entries(value)) {
    exports[key] = parseExportTarget(target, key);
  }
  return exports;
}

function parseDependencies(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('package.json "dependencies" is not an object');
  const dependencies: Record<string, string> = {};
  for (const [key, version] of Object.entries(value)) {
    if (typeof version !== "string") throw new Error(`package.json dependency "${key}" is not a string`);
    dependencies[key] = version;
  }
  return dependencies;
}

function parsePackageManifest(value: unknown): PackageManifest {
  if (!isRecord(value)) throw new Error("package.json is not an object");
  const name = value.name;
  if (typeof name !== "string") throw new Error('package.json "name" is not a string');
  const exports = parseExports(value.exports);
  const dependencies = parseDependencies(value.dependencies);
  return dependencies === undefined ? { name, exports } : { name, exports, dependencies };
}

async function readPackageJson(dir: string): Promise<PackageManifest> {
  const parsed: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  return parsePackageManifest(parsed);
}

function parsePackPath(entry: unknown): string {
  if (!isRecord(entry)) throw new Error("npm pack --json file entry is not an object");
  const path = entry.path;
  if (typeof path !== "string") throw new Error('npm pack --json file entry is missing a string "path"');
  return path;
}

async function packPaths(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--dry-run"], { cwd: dir });
  const inventory: unknown = JSON.parse(stdout);
  if (!Array.isArray(inventory) || inventory.length === 0) throw new Error("npm pack --json produced no inventory");
  const [manifest] = inventory;
  if (!isRecord(manifest)) throw new Error("npm pack --json inventory entry is not an object");
  const files = manifest.files;
  if (!Array.isArray(files)) throw new Error('npm pack --json inventory entry is missing a "files" array');
  return files.map(parsePackPath).sort();
}

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
