import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
  inspectSpaceRegistry,
  recordQmdFreshness,
  registerSpace,
  resolveActiveSpace,
  selectSpace,
} from "../src/spaceRegistry.ts";
import { defaultQmdCacheHome, defaultQmdConfigDir } from "../src/qmdConfigGuard.ts";
import { FIXTURES_DIR } from "./testSupport.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

type LocalFixture = {
  bindingPath: string;
  qmdCacheHome: string;
  qmdConfigDir: string;
  registryPath: string;
  sessionsDir: string;
  spaceRoot: string;
};

async function localFixture(fixtureName: "space-a" | "space-b", suffix: string): Promise<LocalFixture> {
  const root = await mkdtemp(join(tmpdir(), "engram-space-registry-test-"));
  roots.push(root);

  const spaceRoot = join(root, "space");
  const qmdConfigDir = join(root, "qmd-config");
  const qmdCacheHome = join(root, "qmd-cache");
  const sessionsDir = join(root, "sessions");
  await cp(join(FIXTURES_DIR, fixtureName), spaceRoot, { recursive: true });
  await Promise.all([
    mkdir(qmdConfigDir, { recursive: true }),
    mkdir(qmdCacheHome, { recursive: true }),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  const bindingPath = join(root, "binding.json");
  await writeFile(
    bindingPath,
    JSON.stringify({
      schema_version: 0,
      manifest_path: join(spaceRoot, "space.json"),
      qmd_config_dir: qmdConfigDir,
      qmd_cache_home: qmdCacheHome,
      qmd_collection_name: `fictional-${suffix}`,
      sessions_dir: sessionsDir,
      read_roots: [spaceRoot],
      write_roots: [spaceRoot],
      provider_policy: {
        allowed_models: ["fictional-provider/fictional-model"],
        credential_env: ["FICTIONAL_PROVIDER_TOKEN"],
      },
      installed_packs: [{ id: "fictional-pack", version: "0.1.0" }],
    }),
    "utf8",
  );

  return {
    bindingPath,
    qmdCacheHome,
    qmdConfigDir,
    registryPath: join(root, "registry.json"),
    sessionsDir,
    spaceRoot,
  };
}

async function writeRegistryLock(registryPath: string, pid: number, token: string): Promise<string> {
  const lockPath = `${registryPath}.lock`;
  await writeFile(lockPath, JSON.stringify({ schema_version: 0, pid, hostname: hostname(), token }), {
    encoding: "utf8",
    flag: "wx",
  });
  return lockPath;
}

test("a portable manifest containing an absolute records directory is refused", async () => {
  const fixture = await localFixture("space-a", "absolute-records");
  const manifestPath = join(fixture.spaceRoot, "space.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.records_dir = join(fixture.spaceRoot, "records");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("records_dir") && error.includes("relative")));
});

test("a portable manifest refuses a Windows-shaped machine path on every host platform", async () => {
  const fixture = await localFixture("space-a", "windows-records");
  const manifestPath = join(fixture.spaceRoot, "space.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.records_dir = "C:\\fictional\\records";
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("records_dir") && error.includes("relative")));
});

test("registration rejects a local binding that contains an inline credential", async () => {
  const fixture = await localFixture("space-a", "inline-credential");
  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
  binding.api_key = "forbidden-inline-value";
  await writeFile(fixture.bindingPath, JSON.stringify(binding), "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("api_key") && error.includes("unknown")));
});

test("credential policy accepts environment-variable names, not inline credential-shaped values", async () => {
  const fixture = await localFixture("space-a", "credential-reference");
  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
  binding.provider_policy = {
    allowed_models: ["fictional-provider/fictional-model"],
    credential_env: ["not an environment variable name"],
  };
  await writeFile(fixture.bindingPath, JSON.stringify(binding), "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("credential_env") && error.includes("variable name")));
});

test("registration refuses a binding whose installed pack version does not satisfy the portable manifest", async () => {
  const fixture = await localFixture("space-a", "pack-mismatch");
  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
  binding.installed_packs = [{ id: "fictional-pack", version: "9.9.9" }];
  await writeFile(fixture.bindingPath, JSON.stringify(binding), "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("fictional-pack") && error.includes("0.1.0")));
});

test("permitted knowledge roots cannot broaden access above the portable space root", async () => {
  const fixture = await localFixture("space-a", "broad-root");
  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
  binding.read_roots = [dirname(fixture.spaceRoot)];
  await writeFile(fixture.bindingPath, JSON.stringify(binding), "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("read_roots") && error.includes("space root")));
});

test("a write root above the portable space root is refused at registration", async () => {
  const fixture = await localFixture("space-a", "broad-write-root");
  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
  binding.write_roots = [dirname(fixture.spaceRoot)];
  await writeFile(fixture.bindingPath, JSON.stringify(binding), "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("write_roots") && error.includes("space root")));
});

test("write roots must authorize records even when read roots do", async () => {
  const fixture = await localFixture("space-a", "write-records-scope");
  const otherWriteRoot = join(fixture.spaceRoot, "other-writes");
  await mkdir(otherWriteRoot);
  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
  binding.write_roots = [otherWriteRoot];
  await writeFile(fixture.bindingPath, JSON.stringify(binding), "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("write_roots") && error.includes("records_dir")));
});

test("an unsupported knowledge schema version is refused at registration", async () => {
  const fixture = await localFixture("space-a", "unsupported-schema");
  const manifestPath = join(fixture.spaceRoot, "space.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.knowledge_schema_version = "999";
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("unsupported knowledge schema version 999")));
});

test("two fictional spaces register with distinct roots, qmd state, and session locations", async () => {
  const a = await localFixture("space-a", "space-a");
  const b = await localFixture("space-b", "space-b");

  assert.equal((await registerSpace(a.registryPath, a.bindingPath)).ok, true);
  assert.equal((await registerSpace(a.registryPath, b.bindingPath)).ok, true);

  const status = await inspectSpaceRegistry(a.registryPath);
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.deepEqual(status.value.registered_spaces, ["fictional-space-a", "fictional-space-b"]);
  assert.deepEqual(status.value.active_spaces, {});
});

test("a live registry lock refuses a mutation with a distinct lock-conflict error", async () => {
  const fixture = await localFixture("space-a", "live-lock");
  const lockPath = await writeRegistryLock(fixture.registryPath, process.pid, "fictional-live-owner");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("registry lock") && error.includes("held")));
  assert.equal((await stat(lockPath)).isFile(), true);
});

test("every registry state mutation refuses a live lock without changing the registry", async () => {
  const fixture = await localFixture("space-a", "all-mutations-lock");
  assert.equal((await registerSpace(fixture.registryPath, fixture.bindingPath)).ok, true);
  const before = await readFile(fixture.registryPath, "utf8");

  const selectionLock = await writeRegistryLock(fixture.registryPath, process.pid, "fictional-select-owner");
  const selection = await selectSpace(fixture.registryPath, "fictional-space-a", "locked-session");
  assert.equal(selection.ok, false);
  if (!selection.ok) assert.ok(selection.errors.some((error) => error.includes("registry lock")));
  assert.equal(await readFile(fixture.registryPath, "utf8"), before);
  await rm(selectionLock);

  const freshnessLock = await writeRegistryLock(fixture.registryPath, process.pid, "fictional-freshness-owner");
  const freshness = await recordQmdFreshness(fixture.registryPath, "fictional-space-a", "fresh");
  assert.equal(freshness.ok, false);
  if (!freshness.ok) assert.ok(freshness.errors.some((error) => error.includes("registry lock")));
  assert.equal(await readFile(fixture.registryPath, "utf8"), before);
  await rm(freshnessLock);

  const errorLock = await writeRegistryLock(fixture.registryPath, process.pid, "fictional-error-owner");
  const resolution = await resolveActiveSpace({
    ENGRAM_BINDING_REGISTRY: fixture.registryPath,
    ENGRAM_HOST_SESSION_ID: "unselected-session",
  });
  assert.equal(resolution.ok, false);
  if (!resolution.ok) assert.ok(resolution.errors.some((error) => error.includes("registry lock")));
  assert.equal(await readFile(fixture.registryPath, "utf8"), before);
  await rm(errorLock);
});

test("an unverifiable registry lock is refused and never removed as though its owner were absent", async () => {
  const fixture = await localFixture("space-a", "unverifiable-lock");
  const lockPath = `${fixture.registryPath}.lock`;
  await writeFile(lockPath, "not valid owner metadata", "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("registry lock") && error.includes("cannot be validated")));
  assert.equal(await readFile(lockPath, "utf8"), "not valid owner metadata");
});

test("a lock whose recorded process is proven absent is recovered without assuming a live owner is gone, even with an orphaned recovery marker", async () => {
  const fixture = await localFixture("space-a", "stale-lock");
  const lockPath = await writeRegistryLock(fixture.registryPath, 2_147_483_647, "fictional-dead-owner");
  const recoveryPath = `${lockPath}.recovery`;
  await writeFile(
    recoveryPath,
    JSON.stringify({
      schema_version: 0,
      pid: 2_147_483_647,
      hostname: hostname(),
      token: "fictional-dead-recovery-owner",
      purpose: "recovery",
    }),
    { encoding: "utf8", flag: "wx" },
  );

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, true);
  await assert.rejects(stat(lockPath));
  await assert.rejects(stat(recoveryPath));
});

test("overlapping registrations never lose a space whose caller was told it succeeded", async () => {
  const a = await localFixture("space-a", "concurrent-a");
  const b = await localFixture("space-b", "concurrent-b");

  const [registeredA, registeredB] = await Promise.all([
    registerSpace(a.registryPath, a.bindingPath),
    registerSpace(a.registryPath, b.bindingPath),
  ]);
  const status = await inspectSpaceRegistry(a.registryPath);
  assert.equal(status.ok, true);
  if (!status.ok) return;
  if (registeredA.ok) assert.ok(status.value.registered_spaces.includes("fictional-space-a"));
  if (registeredB.ok) assert.ok(status.value.registered_spaces.includes("fictional-space-b"));
  if (!registeredA.ok) assert.ok(registeredA.errors.some((error) => error.includes("registry lock")));
  if (!registeredB.ok) assert.ok(registeredB.errors.some((error) => error.includes("registry lock")));
});

test("registration refuses two spaces that share a session location", async () => {
  const a = await localFixture("space-a", "isolated-a");
  const b = await localFixture("space-b", "isolated-b");
  assert.equal((await registerSpace(a.registryPath, a.bindingPath)).ok, true);

  const binding = JSON.parse(await readFile(b.bindingPath, "utf8")) as Record<string, unknown>;
  binding.sessions_dir = a.sessionsDir;
  const collidingBinding = join(b.spaceRoot, "colliding-binding.json");
  await writeFile(collidingBinding, JSON.stringify(binding), "utf8");

  const result = await registerSpace(a.registryPath, collidingBinding);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("sessions_dir") && error.includes("already")));
});

test("registration refuses nested durable space roots because the outer space could reach the inner one", async () => {
  const a = await localFixture("space-a", "outer-space");
  const b = await localFixture("space-b", "inner-space");
  assert.equal((await registerSpace(a.registryPath, a.bindingPath)).ok, true);

  const nestedRoot = join(a.spaceRoot, "nested-space");
  await cp(b.spaceRoot, nestedRoot, { recursive: true });
  const binding = JSON.parse(await readFile(b.bindingPath, "utf8")) as Record<string, unknown>;
  binding.manifest_path = join(nestedRoot, "space.json");
  binding.read_roots = [nestedRoot];
  binding.write_roots = [nestedRoot];
  const nestedBinding = join(b.spaceRoot, "nested-binding.json");
  await writeFile(nestedBinding, JSON.stringify(binding), "utf8");

  const result = await registerSpace(a.registryPath, nestedBinding);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("space root") && error.includes("overlaps")));
});

test("registration refuses two spaces that share either qmd configuration or qmd cache state", async () => {
  const a = await localFixture("space-a", "qmd-a");
  const b = await localFixture("space-b", "qmd-b");
  assert.equal((await registerSpace(a.registryPath, a.bindingPath)).ok, true);

  const sharedConfig = JSON.parse(await readFile(b.bindingPath, "utf8")) as Record<string, unknown>;
  sharedConfig.qmd_config_dir = a.qmdConfigDir;
  const sharedConfigPath = join(b.spaceRoot, "shared-config-binding.json");
  await writeFile(sharedConfigPath, JSON.stringify(sharedConfig), "utf8");
  const configResult = await registerSpace(a.registryPath, sharedConfigPath);
  assert.equal(configResult.ok, false);
  if (configResult.ok) return;
  assert.ok(configResult.errors.some((error) => error.includes("qmd_config_dir") && error.includes("already")));

  const sharedCache = JSON.parse(await readFile(b.bindingPath, "utf8")) as Record<string, unknown>;
  sharedCache.qmd_cache_home = a.qmdCacheHome;
  const sharedCachePath = join(b.spaceRoot, "shared-cache-binding.json");
  await writeFile(sharedCachePath, JSON.stringify(sharedCache), "utf8");
  const cacheResult = await registerSpace(a.registryPath, sharedCachePath);
  assert.equal(cacheResult.ok, false);
  if (cacheResult.ok) return;
  assert.ok(cacheResult.errors.some((error) => error.includes("qmd_cache_home") && error.includes("already")));
});

test("registration refuses a duplicate qmd collection name even when every path is disjoint", async () => {
  const a = await localFixture("space-a", "duplicate-collection");
  const b = await localFixture("space-b", "unique-before-edit");
  assert.equal((await registerSpace(a.registryPath, a.bindingPath)).ok, true);

  const binding = JSON.parse(await readFile(b.bindingPath, "utf8")) as Record<string, unknown>;
  binding.qmd_collection_name = "fictional-duplicate-collection";
  await writeFile(b.bindingPath, JSON.stringify(binding), "utf8");

  const result = await registerSpace(a.registryPath, b.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("qmd_collection_name") && error.includes("already")));
});

test("the real default qmd config directory is refused during registration", async () => {
  const fixture = await localFixture("space-a", "default-config-registration");
  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
  binding.qmd_config_dir = defaultQmdConfigDir();
  await writeFile(fixture.bindingPath, JSON.stringify(binding), "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("qmd_config_dir") && error.includes("default")));
});

test("the real default qmd cache home is refused during registration", async () => {
  const fixture = await localFixture("space-a", "default-cache-registration");
  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
  binding.qmd_cache_home = defaultQmdCacheHome();
  await writeFile(fixture.bindingPath, JSON.stringify(binding), "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("qmd_cache_home") && error.includes("default")));
});

test("changing spaces requires a different host session and leaves the prior selection active on refusal", async () => {
  const a = await localFixture("space-a", "select-a");
  const b = await localFixture("space-b", "select-b");
  assert.equal((await registerSpace(a.registryPath, a.bindingPath)).ok, true);
  assert.equal((await registerSpace(a.registryPath, b.bindingPath)).ok, true);
  assert.equal((await selectSpace(a.registryPath, "fictional-space-a", "host-session-1")).ok, true);

  const refused = await selectSpace(a.registryPath, "fictional-space-b", "host-session-1");

  assert.equal(refused.ok, false);
  const status = await inspectSpaceRegistry(a.registryPath);
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.value.active_spaces["host-session-1"]?.space_id, "fictional-space-a");
  assert.match(status.value.last_boundary_error ?? "", /fresh host session/);

  const switched = await selectSpace(a.registryPath, "fictional-space-b", "host-session-2");
  assert.equal(switched.ok, true);
  assert.equal((await stat(join(b.sessionsDir, "host-session-2"))).isDirectory(), true);
  await assert.rejects(stat(join(a.sessionsDir, "host-session-2")));
});

test("a knowledge operation resolves only the selected space for the current host session", async () => {
  const a = await localFixture("space-a", "active-a");
  const b = await localFixture("space-b", "active-b");
  assert.equal((await registerSpace(a.registryPath, a.bindingPath)).ok, true);
  assert.equal((await registerSpace(a.registryPath, b.bindingPath)).ok, true);
  assert.equal((await selectSpace(a.registryPath, "fictional-space-a", "host-session-a")).ok, true);

  const active = await resolveActiveSpace({
    ENGRAM_BINDING_REGISTRY: a.registryPath,
    ENGRAM_HOST_SESSION_ID: "host-session-a",
  });

  assert.equal(active.ok, true);
  if (!active.ok) return;
  assert.equal(active.value.spaceId, "fictional-space-a");
  assert.ok(active.value.recordsRoot.startsWith(await realpath(a.spaceRoot)));
  assert.ok(!active.value.recordsRoot.startsWith(await realpath(b.spaceRoot)));

  const wrongSession = await resolveActiveSpace({
    ENGRAM_BINDING_REGISTRY: a.registryPath,
    ENGRAM_HOST_SESSION_ID: "host-session-b",
  });
  assert.equal(wrongSession.ok, false);
  const statusAfterRefusal = await inspectSpaceRegistry(a.registryPath);
  assert.equal(statusAfterRefusal.ok, true);
  if (!statusAfterRefusal.ok) return;
  assert.match(statusAfterRefusal.value.last_boundary_error ?? "", /no active space.*host session/);
});

test("one host session cannot displace another session from its selected space", async () => {
  const a = await localFixture("space-a", "session-map-a");
  const b = await localFixture("space-b", "session-map-b");
  assert.equal((await registerSpace(a.registryPath, a.bindingPath)).ok, true);
  assert.equal((await registerSpace(a.registryPath, b.bindingPath)).ok, true);
  assert.equal((await selectSpace(a.registryPath, "fictional-space-a", "session-a")).ok, true);
  assert.equal((await selectSpace(a.registryPath, "fictional-space-b", "session-b")).ok, true);

  assert.equal((await selectSpace(a.registryPath, "fictional-space-a", "session-a")).ok, true);
  const resolved = await resolveActiveSpace({
    ENGRAM_BINDING_REGISTRY: a.registryPath,
    ENGRAM_HOST_SESSION_ID: "session-a",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.value.spaceId, "fictional-space-a");
});

test("the registry serializes independent active selections for two host sessions", async () => {
  const a = await localFixture("space-a", "serialized-session-a");
  const b = await localFixture("space-b", "serialized-session-b");
  assert.equal((await registerSpace(a.registryPath, a.bindingPath)).ok, true);
  assert.equal((await registerSpace(a.registryPath, b.bindingPath)).ok, true);
  assert.equal((await selectSpace(a.registryPath, "fictional-space-a", "serialized-a")).ok, true);
  assert.equal((await selectSpace(a.registryPath, "fictional-space-b", "serialized-b")).ok, true);

  const registry = JSON.parse(await readFile(a.registryPath, "utf8")) as { active: Record<string, string> };
  assert.deepEqual(registry.active, {
    "serialized-a": "fictional-space-a",
    "serialized-b": "fictional-space-b",
  });
});

test("editing a registered binding cannot redirect the selected space without re-registration", async () => {
  const a = await localFixture("space-a", "stable-a");
  const b = await localFixture("space-b", "redirect-b");
  assert.equal((await registerSpace(a.registryPath, a.bindingPath)).ok, true);
  assert.equal((await selectSpace(a.registryPath, "fictional-space-a", "stable-session")).ok, true);

  const redirectedBinding = await readFile(b.bindingPath, "utf8");
  await writeFile(a.bindingPath, redirectedBinding, "utf8");

  const resolved = await resolveActiveSpace({
    ENGRAM_BINDING_REGISTRY: a.registryPath,
    ENGRAM_HOST_SESSION_ID: "stable-session",
  });

  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.ok(resolved.errors.some((error) => error.includes("changed since registration")));
});

test("a stale registered space does not block registering, selecting, or resolving an unrelated space", async () => {
  const a = await localFixture("space-a", "stale-a");
  const b = await localFixture("space-b", "healthy-b");
  assert.equal((await registerSpace(a.registryPath, a.bindingPath)).ok, true);

  const staleBinding = JSON.parse(await readFile(a.bindingPath, "utf8")) as Record<string, unknown>;
  staleBinding.qmd_collection_name = "fictional-stale-a-edited";
  await writeFile(a.bindingPath, JSON.stringify(staleBinding), "utf8");

  assert.equal((await registerSpace(a.registryPath, b.bindingPath)).ok, true);
  assert.equal((await selectSpace(a.registryPath, "fictional-space-b", "healthy-session")).ok, true);
  const resolved = await resolveActiveSpace({
    ENGRAM_BINDING_REGISTRY: a.registryPath,
    ENGRAM_HOST_SESSION_ID: "healthy-session",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.value.spaceId, "fictional-space-b");
});

test("reserializing a registered binding without semantic changes leaves the space usable", async () => {
  const fixture = await localFixture("space-a", "reserialized-binding");
  assert.equal((await registerSpace(fixture.registryPath, fixture.bindingPath)).ok, true);
  assert.equal((await selectSpace(fixture.registryPath, "fictional-space-a", "format-session")).ok, true);

  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8"));
  await writeFile(fixture.bindingPath, JSON.stringify(binding, null, 2) + "\n", "utf8");

  const resolved = await resolveActiveSpace({
    ENGRAM_BINDING_REGISTRY: fixture.registryPath,
    ENGRAM_HOST_SESSION_ID: "format-session",
  });
  assert.equal(resolved.ok, true);
});

test("a compatible required-pack manifest edit leaves the registered space usable", async () => {
  const fixture = await localFixture("space-a", "compatible-pack-upgrade");
  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
  binding.installed_packs = [
    { id: "fictional-pack", version: "0.1.0" },
    { id: "fictional-pack-two", version: "0.2.0" },
  ];
  await writeFile(fixture.bindingPath, JSON.stringify(binding), "utf8");
  assert.equal((await registerSpace(fixture.registryPath, fixture.bindingPath)).ok, true);
  assert.equal((await selectSpace(fixture.registryPath, "fictional-space-a", "pack-session")).ok, true);

  const manifestPath = join(fixture.spaceRoot, "space.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.required_packs = [
    { id: "fictional-pack", version: "0.1.0" },
    { id: "fictional-pack-two", version: "0.2.0" },
  ];
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  const resolved = await resolveActiveSpace({
    ENGRAM_BINDING_REGISTRY: fixture.registryPath,
    ENGRAM_HOST_SESSION_ID: "pack-session",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.value.packs, manifest.required_packs);
});

test("binding from and extract fields are carried through to active space packs", async () => {
  const fixture = await localFixture("space-a", "from-extract");
  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
  binding.installed_packs = [
    { id: "fictional-pack", version: "0.1.0", from: "@scope/fictional-pack", extract: true },
  ];
  await writeFile(fixture.bindingPath, JSON.stringify(binding), "utf8");
  assert.equal((await registerSpace(fixture.registryPath, fixture.bindingPath)).ok, true);
  assert.equal((await selectSpace(fixture.registryPath, "fictional-space-a", "from-extract-session")).ok, true);

  const resolved = await resolveActiveSpace({
    ENGRAM_BINDING_REGISTRY: fixture.registryPath,
    ENGRAM_HOST_SESSION_ID: "from-extract-session",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.value.packs.length, 1);
  const pack = resolved.value.packs[0];
  assert.ok(pack !== undefined);
  assert.equal(pack.id, "fictional-pack");
  assert.equal(pack.from, "@scope/fictional-pack");
  assert.equal(pack.extract, true);
});

test("binding with two extract packs is rejected", async () => {
  const fixture = await localFixture("space-a", "dual-extract");
  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
  binding.installed_packs = [
    { id: "fictional-pack", version: "0.1.0", extract: true },
    { id: "fictional-pack-two", version: "99.99.99", extract: true },
  ];
  await writeFile(fixture.bindingPath, JSON.stringify(binding), "utf8");

  const result = await registerSpace(fixture.registryPath, fixture.bindingPath);
  assert.equal(result.ok, false);
  assert.ok(result.errors?.some((e: string) => e.includes("extract: true")));
});

test("pack in required_packs with matching installed_packs but no from/extract merges cleanly", async () => {
  const fixture = await localFixture("space-a", "matching-packs");
  const manifestPath = join(fixture.spaceRoot, "space.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.required_packs = [
    { id: "fictional-pack", version: "0.1.0" },
    { id: "fictional-pack-two", version: "0.2.0" },
  ];
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
  binding.installed_packs = [
    { id: "fictional-pack", version: "0.1.0", from: "@scope/fictional-pack", extract: true },
    { id: "fictional-pack-two", version: "0.2.0" },
  ];
  await writeFile(fixture.bindingPath, JSON.stringify(binding), "utf8");

  assert.equal((await registerSpace(fixture.registryPath, fixture.bindingPath)).ok, true);
  assert.equal((await selectSpace(fixture.registryPath, "fictional-space-a", "matching-packs-session")).ok, true);

  const resolved = await resolveActiveSpace({
    ENGRAM_BINDING_REGISTRY: fixture.registryPath,
    ENGRAM_HOST_SESSION_ID: "matching-packs-session",
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.value.packs.length, 2);

  const packA = resolved.value.packs[0]!;
  assert.equal(packA.id, "fictional-pack");
  assert.equal(packA.from, "@scope/fictional-pack");
  assert.equal(packA.extract, true);

  const packB = resolved.value.packs[1]!;
  assert.equal(packB.id, "fictional-pack-two");
  assert.equal(packB.from, undefined);
  assert.equal(packB.extract, undefined);
});

test("effective status is readable and omits credential references", async () => {
  const fixture = await localFixture("space-a", "status");
  assert.equal((await registerSpace(fixture.registryPath, fixture.bindingPath)).ok, true);
  assert.equal((await selectSpace(fixture.registryPath, "fictional-space-a", "status-session")).ok, true);

  const status = await inspectSpaceRegistry(fixture.registryPath);

  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.value.active_spaces["status-session"]?.compatibility, "compatible");
  assert.equal(status.value.active_spaces["status-session"]?.qmd_freshness, "unknown");
  assert.equal(status.value.active_spaces["status-session"]?.session_boundary, "validated-not-enforced");
  const serialized = JSON.stringify(status.value);
  assert.doesNotMatch(serialized, /FICTIONAL_PROVIDER_TOKEN|credential_env|forbidden-inline-value/);
});
