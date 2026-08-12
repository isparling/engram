// End-to-end test that an external process — standing in for "an existing
// host" — can invoke the one operation through the provisional CLI, with
// the space binding supplied only via environment variables (never a CLI
// flag).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { registerSpace, selectSpace } from "../src/spaceRegistry.ts";
import { guardedRetrieve } from "../src/guardedRetrieval.ts";
import { fictionalPack } from "../test/fictionalPack.ts";
import {
  createEphemeralSpace,
  destroyEphemeralSpace,
  SPACE_A_RECORDS_DIR,
  SPACE_B_RECORDS_DIR,
  writeLocalBindingFixture,
  type EphemeralSpace,
} from "./testSupport.ts";

const execFileAsync = promisify(execFile);
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

const spacesToClean: EphemeralSpace[] = [];
const scratchDirsToClean: string[] = [];

async function writeCandidateFile(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "engram-cli-candidate-"));
  scratchDirsToClean.push(dir);
  const path = join(dir, "candidate.json");
  await writeFile(path, JSON.stringify(content), "utf8");
  return path;
}

after(async () => {
  for (const s of spacesToClean) {
    await destroyEphemeralSpace(s);
  }
  for (const dir of scratchDirsToClean) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function runCli(
  args: string[],
  registryPath: string,
  hostSessionId: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        ENGRAM_BINDING_REGISTRY: registryPath,
        ENGRAM_HOST_SESSION_ID: hostSessionId,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function syntheticReleaseManifest(): Record<string, unknown> {
  const sourceRevision = "a".repeat(40);
  return {
    schema_version: 0,
    release_format: 0,
    version: `r0-${sourceRevision}`,
    source_revision: sourceRevision,
    packaging_procedure_version: "r0-source-ustar-v1",
    host_agent_compatibility: "host-neutral-cli-schema-0",
    qmd_compatibility: { contract: "scoped-cli", version: "0.1.0" },
    knowledge_schema_compatibility: ["0"],
    pack_api_compatibility: 0,
    environment_compatibility: { platform: "darwin", architecture: "arm64", node_version: process.version },
    included_packs: [{ id: "fictional-integrity", version: "0.1.0" }],
    files: [{ path: "harness/src/cli.ts", byte_length: 42, sha256: "d".repeat(64), executable: false }],
  };
}

async function runSyntheticReleaseCli(
  args: string[],
  manifest: Record<string, unknown> | undefined,
): Promise<{ code: number; stdout: string; stderr: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "engram-synthetic-release-"));
  scratchDirsToClean.push(root);
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  await Promise.all([
    cp(join(repositoryRoot, "harness", "src"), join(root, "harness", "src"), { recursive: true }),
    cp(join(repositoryRoot, "release"), join(root, "release"), { recursive: true }).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
      throw error;
    }),
  ]);
  await writeFile(join(root, "harness", "package.json"), '{"type":"module"}\n', "utf8");
  if (manifest !== undefined) await writeFile(join(root, "release-manifest.json"), JSON.stringify(manifest), "utf8");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [join(root, "harness", "src", "cli.ts"), ...args], {
      env: { PATH: process.env.PATH },
    });
    return { code: 0, stdout, stderr, root };
  } catch (error) {
    if (typeof error !== "object" || error === null) return { code: 1, stdout: "", stderr: "", root };
    const code = "code" in error && typeof error.code === "number" ? error.code : 1;
    const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    return { code, stdout, stderr, root };
  }
}

async function prepareActiveSpace(space: EphemeralSpace, spaceId: string, hostSessionId: string): Promise<string> {
  const registryPath = join(space.root, "registry.json");
  const bindingPath = await writeLocalBindingFixture(space, spaceId);
  const registered = await registerSpace(registryPath, bindingPath);
  assert.equal(registered.ok, true);
  const selected = await selectSpace(registryPath, spaceId, hostSessionId);
  assert.equal(selected.ok, true);
  return registryPath;
}

test("CLI: an additive candidate commits end to end and prints a schema_version: 0 JSON result", async () => {
  const s = await createEphemeralSpace(SPACE_A_RECORDS_DIR, "cli-additive");
  spacesToClean.push(s);
  const registryPath = await prepareActiveSpace(s, "cli-additive", "cli-additive-session");

  const candidatePath = await writeCandidateFile({
    target_id: "payments-gateway",
    source: "cli-test",
    add_claims: ["Added through the CLI end-to-end test."],
  });

  const result = await runCli(["submit", "--candidate", candidatePath], registryPath, "cli-additive-session");
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);

  const parsed = JSON.parse(result.stdout) as { schema_version: number; status: string; refresh: { count: number } };
  assert.equal(parsed.schema_version, 0);
  assert.equal(parsed.status, "committed");
  assert.equal(parsed.refresh.count, 1);

  const status = await runCli(["space", "status"], registryPath, "cli-additive-session");
  const statusParsed = JSON.parse(status.stdout) as { active_spaces: Record<string, { qmd_freshness: string }> };
  assert.equal(statusParsed.active_spaces["cli-additive-session"]?.qmd_freshness, "fresh");
});

test("CLI: a non-additive candidate without --approve exits nonzero and writes nothing", async () => {
  const s = await createEphemeralSpace(SPACE_A_RECORDS_DIR, "cli-non-additive");
  spacesToClean.push(s);
  const registryPath = await prepareActiveSpace(s, "cli-non-additive", "cli-non-additive-session");

  const candidatePath = await writeCandidateFile({
    target_id: "ledger-reconciler",
    source: "cli-test",
    remove_claims: [
      "The job's service account has broader S3 read access than the reconciliation path requires, scoped at the bucket level rather than the prefix level. [source: access-review-2026-Q2]",
    ],
  });

  const result = await runCli(["submit", "--candidate", candidatePath], registryPath, "cli-non-additive-session");
  assert.equal(result.code, 2, `stderr: ${result.stderr}`);

  const parsed = JSON.parse(result.stdout) as { schema_version: number; status: string; refresh: { count: number } };
  assert.equal(parsed.schema_version, 0);
  assert.equal(parsed.status, "approval_required");
  assert.equal(parsed.refresh.count, 0);
});

test("CLI: full two-step approval flow — diff, then --approve --expect <hash> — commits", async () => {
  const s = await createEphemeralSpace(SPACE_A_RECORDS_DIR, "cli-two-step-approve");
  spacesToClean.push(s);
  const registryPath = await prepareActiveSpace(s, "cli-two-step-approve", "cli-two-step-session");

  const candidatePath = await writeCandidateFile({
    target_id: "ledger-reconciler",
    source: "cli-test",
    remove_claims: [
      "The job's service account has broader S3 read access than the reconciliation path requires, scoped at the bucket level rather than the prefix level. [source: access-review-2026-Q2]",
    ],
  });

  const preview = await runCli(["submit", "--candidate", candidatePath], registryPath, "cli-two-step-session");
  assert.equal(preview.code, 2, `stderr: ${preview.stderr}`);
  const previewParsed = JSON.parse(preview.stdout) as { status: string; plan_hash: string };
  assert.equal(previewParsed.status, "approval_required");
  assert.match(previewParsed.plan_hash, /^[0-9a-f]{64}$/);

  const approved = await runCli(
    ["submit", "--candidate", candidatePath, "--approve", "--expect", previewParsed.plan_hash],
    registryPath,
    "cli-two-step-session",
  );
  assert.equal(approved.code, 0, `stderr: ${approved.stderr}`);
  const approvedParsed = JSON.parse(approved.stdout) as { status: string };
  assert.equal(approvedParsed.status, "committed");
});

test("CLI: --approve without --expect is a usage error (exit 1), never a silent commit", async () => {
  const s = await createEphemeralSpace(SPACE_A_RECORDS_DIR, "cli-approve-without-expect");
  spacesToClean.push(s);
  const registryPath = await prepareActiveSpace(s, "cli-approve-without-expect", "cli-approve-session");

  const candidatePath = await writeCandidateFile({
    target_id: "ledger-reconciler",
    source: "cli-test",
    remove_claims: [
      "The job's service account has broader S3 read access than the reconciliation path requires, scoped at the bucket level rather than the prefix level. [source: access-review-2026-Q2]",
    ],
  });

  const result = await runCli(["submit", "--candidate", candidatePath, "--approve"], registryPath, "cli-approve-session");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--expect/);
});

test("CLI: approving with a stale hash exits 3 (stale_approval), distinct from approval_required and invalid", async () => {
  const s = await createEphemeralSpace(SPACE_A_RECORDS_DIR, "cli-stale-approval");
  spacesToClean.push(s);
  const registryPath = await prepareActiveSpace(s, "cli-stale-approval", "cli-stale-session");

  const candidatePath = await writeCandidateFile({
    target_id: "ledger-reconciler",
    source: "cli-test",
    remove_claims: [
      "The job's service account has broader S3 read access than the reconciliation path requires, scoped at the bucket level rather than the prefix level. [source: access-review-2026-Q2]",
    ],
  });

  const preview = await runCli(["submit", "--candidate", candidatePath], registryPath, "cli-stale-session");
  const previewParsed = JSON.parse(preview.stdout) as { plan_hash: string };

  const result = await runCli(
    ["submit", "--candidate", candidatePath, "--approve", "--expect", "0".repeat(64)],
    registryPath,
    "cli-stale-session",
  );
  assert.equal(result.code, 3, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { status: string };
  assert.equal(parsed.status, "stale_approval");
  assert.notEqual(previewParsed.plan_hash, "0".repeat(64));
});

test("CLI: refuses to run with no space binding in the environment", async () => {
  const candidatePath = await writeCandidateFile({ target_id: "payments-gateway", source: "x" });

  try {
    await execFileAsync(process.execPath, [CLI_PATH, "submit", "--candidate", candidatePath], {
      env: {
        PATH: process.env.PATH,
        // Deliberately no Engram_* binding vars.
      },
    });
    assert.fail("expected the CLI to exit nonzero without a space binding");
  } catch (error) {
    const e = error as { code?: number; stdout?: string };
    assert.notEqual(e.code, 0);
    const parsed = JSON.parse(e.stdout ?? "{}") as { status: string };
    assert.equal(parsed.status, "invalid");
  }
});

test("CLI: register, select, and inspect two fictional spaces without exposing credential references", async () => {
  const a = await createEphemeralSpace(SPACE_A_RECORDS_DIR, "cli-registry-a");
  const b = await createEphemeralSpace(SPACE_B_RECORDS_DIR, "cli-registry-b");
  spacesToClean.push(a, b);
  const bindingA = await writeLocalBindingFixture(a, "fictional-space-a");
  const bindingB = await writeLocalBindingFixture(b, "fictional-space-b");
  const registryPath = join(a.root, "two-space-registry.json");

  assert.equal((await runCli(["space", "register", "--binding", bindingA], registryPath, "host-session-a")).code, 0);
  assert.equal((await runCli(["space", "register", "--binding", bindingB], registryPath, "host-session-a")).code, 0);
  assert.equal((await runCli(["space", "select", "fictional-space-a"], registryPath, "host-session-a")).code, 0);

  const refused = await runCli(["space", "select", "fictional-space-b"], registryPath, "host-session-a");
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /fresh host session/);
  assert.equal((await runCli(["space", "select", "fictional-space-b"], registryPath, "host-session-b")).code, 0);

  const status = await runCli(["space", "status"], registryPath, "host-session-b");
  assert.equal(status.code, 0, status.stderr);
  const parsed = JSON.parse(status.stdout) as {
    registered_spaces: string[];
    active_spaces: Record<string, { space_id: string; session_boundary: string }>;
  };
  assert.deepEqual(parsed.registered_spaces, ["fictional-space-a", "fictional-space-b"]);
  assert.equal(parsed.active_spaces["host-session-a"]?.space_id, "fictional-space-a");
  assert.equal(parsed.active_spaces["host-session-b"]?.space_id, "fictional-space-b");
  assert.equal(parsed.active_spaces["host-session-b"]?.session_boundary, "validated-not-enforced");
  assert.doesNotMatch(status.stdout, /FICTIONAL_PROVIDER_TOKEN|credential_env/);
});

test("CLI: re-registering a stale space revalidates its binding and returns it to service", async () => {
  const space = await createEphemeralSpace(SPACE_A_RECORDS_DIR, "cli-reregister");
  spacesToClean.push(space);
  const bindingPath = await writeLocalBindingFixture(space, "fictional-reregister");
  const registryPath = join(space.root, "reregister-registry.json");

  const firstRegistration = await runCli(
    ["space", "register", "--binding", bindingPath],
    registryPath,
    "reregister-session",
  );
  assert.equal(firstRegistration.code, 0, firstRegistration.stderr);

  const binding = JSON.parse(await readFile(bindingPath, "utf8")) as Record<string, unknown>;
  binding.qmd_collection_name = "cli-reregister-updated";
  await writeFile(bindingPath, JSON.stringify(binding, null, 2) + "\n", "utf8");

  const recovered = await runCli(
    ["space", "register", "--binding", bindingPath],
    registryPath,
    "reregister-session",
  );
  assert.equal(recovered.code, 0, recovered.stdout);
  assert.equal(
    (await runCli(["space", "select", "fictional-reregister"], registryPath, "reregister-session")).code,
    0,
  );
  const status = await runCli(["space", "status"], registryPath, "reregister-session");
  assert.equal(status.code, 0, status.stdout);
  const parsed = JSON.parse(status.stdout) as {
    active_spaces: Record<string, { qmd: { collection: string } }>;
  };
  assert.equal(parsed.active_spaces["reregister-session"]?.qmd.collection, "cli-reregister-updated");
});

test("CLI: a candidate cannot read or write a record that exists only in an unselected registered space", async () => {
  const a = await createEphemeralSpace(SPACE_A_RECORDS_DIR, "cli-boundary-a");
  const b = await createEphemeralSpace(SPACE_B_RECORDS_DIR, "cli-boundary-b");
  spacesToClean.push(a, b);
  const bindingA = await writeLocalBindingFixture(a, "fictional-space-a");
  const bindingB = await writeLocalBindingFixture(b, "fictional-space-b");
  const registryPath = join(a.root, "boundary-registry.json");
  assert.equal((await registerSpace(registryPath, bindingA)).ok, true);
  assert.equal((await registerSpace(registryPath, bindingB)).ok, true);
  assert.equal((await selectSpace(registryPath, "fictional-space-a", "boundary-session")).ok, true);

  const otherRecordPath = join(b.binding.recordsRoot, "notification-relay.md");
  const before = await readFile(otherRecordPath, "utf8");
  const candidatePath = await writeCandidateFile({
    target_id: "notification-relay",
    source: "fictional-boundary-test",
    add_claims: ["This must not reach the unselected space."],
  });

  const result = await runCli(["submit", "--candidate", candidatePath], registryPath, "boundary-session");

  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stdout) as { status: string; errors: string[] };
  assert.equal(parsed.status, "invalid");
  assert.deepEqual(parsed.errors, ["record not found for target_id: notification-relay"]);
  assert.equal(await readFile(otherRecordPath, "utf8"), before);
});

test("CLI: a target present in both spaces is modified only in the selected space", async () => {
  const a = await createEphemeralSpace(SPACE_A_RECORDS_DIR, "cli-shared-target-a");
  const b = await createEphemeralSpace(SPACE_B_RECORDS_DIR, "cli-shared-target-b");
  spacesToClean.push(a, b);
  const selectedRecordPath = join(a.binding.recordsRoot, "payments-gateway.md");
  const unselectedRecordPath = join(b.binding.recordsRoot, "payments-gateway.md");
  await copyFile(selectedRecordPath, unselectedRecordPath);
  const selectedBefore = await readFile(selectedRecordPath, "utf8");
  const unselectedBefore = await readFile(unselectedRecordPath, "utf8");

  const bindingA = await writeLocalBindingFixture(a, "fictional-shared-target-a");
  const bindingB = await writeLocalBindingFixture(b, "fictional-shared-target-b");
  const registryPath = join(a.root, "shared-target-registry.json");
  assert.equal((await registerSpace(registryPath, bindingA)).ok, true);
  assert.equal((await registerSpace(registryPath, bindingB)).ok, true);
  assert.equal((await selectSpace(registryPath, "fictional-shared-target-a", "shared-target-session")).ok, true);

  const claim = "The selected fictional space received this isolated update.";
  const candidatePath = await writeCandidateFile({
    target_id: "payments-gateway",
    source: "fictional-shared-boundary-test",
    add_claims: [claim],
  });
  const result = await runCli(["submit", "--candidate", candidatePath], registryPath, "shared-target-session");

  assert.equal(result.code, 0, result.stdout);
  assert.notEqual(await readFile(selectedRecordPath, "utf8"), selectedBefore);
  assert.ok((await readFile(selectedRecordPath, "utf8")).includes(claim));
  assert.equal(await readFile(unselectedRecordPath, "utf8"), unselectedBefore);
});

test("CLI: `knowledge recall` and `knowledge render` are not commands — the top-level `recall`/`render` spelling is the only one, and it names the usage text", async () => {
  const recallError = await execFileAsync(process.execPath, [CLI_PATH, "knowledge", "recall", "--query", "beacon", "--audience", "peer"], {
    env: { PATH: process.env.PATH },

  }).then(
    () => assert.fail("expected `knowledge recall` to be rejected as an unknown command"),
    (error: unknown) => error as { code?: number; stdout?: string; stderr?: string },
  );
  assert.notEqual(recallError.code, 0);
  assert.equal(recallError.stdout ?? "", "");
  assert.match(recallError.stderr ?? "", /unknown knowledge command: recall/);
  assert.match(recallError.stderr ?? "", /engram recall --query <text> --audience <id>/);

  const renderError = await execFileAsync(process.execPath, [CLI_PATH, "knowledge", "render", "--view", "x", "--audience", "y", "--delivery", "z", "--model", "p/m"], {
    env: { PATH: process.env.PATH },
  }).then(
    () => assert.fail("expected `knowledge render` to be rejected as an unknown command"),
    (error: unknown) => error as { code?: number; stdout?: string; stderr?: string },
  );
  assert.notEqual(renderError.code, 0);
  assert.equal(renderError.stdout ?? "", "");
  assert.match(renderError.stderr ?? "", /unknown knowledge command: render/);
  assert.match(renderError.stderr ?? "", /engram render --view <id>/);
});

test("guardedRetrieve: an unresolved active space names no space in its receipt, and a malformed pack cannot make it throw", async () => {
  const unresolved = await guardedRetrieve(
    { query: "synthetic status", audienceId: "peer", pack: fictionalPack },
    { env: {} },
  );
  assert.equal(unresolved.status, "failed");
  if (unresolved.status !== "failed") return;
  assert.equal(unresolved.errors[0]?.code, "active_space_unresolved");
  assert.equal(unresolved.receipt.activeSpace, null);
  assert.deepEqual(unresolved.receipt.allowedSourceClasses, [...fictionalPack.retrievalPolicy.allowedSourceClasses]);

  // request.pack does not satisfy PresentationPack at runtime (as an
  // untyped caller's JSON might not) — this must not throw on
  // request.pack.retrievalPolicy.allowedSourceClasses.
  const malformedPack = JSON.parse('{"id":"broken-pack"}');
  const malformedResult = await guardedRetrieve(
    { query: "synthetic status", audienceId: "peer", pack: malformedPack },
    { env: {} },
  );
  assert.equal(malformedResult.status, "failed");
  if (malformedResult.status !== "failed") return;
  assert.equal(malformedResult.errors[0]?.code, "active_space_unresolved");
  assert.equal(malformedResult.receipt.activeSpace, null);
  assert.deepEqual(malformedResult.receipt.allowedSourceClasses, []);
});

test("CLI: version reports only the selected immutable release identity", async () => {
  const result = await runSyntheticReleaseCli(["version"], syntheticReleaseManifest());
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema_version: 0,
    status: "version",
    release_id: `r0-${"a".repeat(40)}`,
    source_revision: "a".repeat(40),
  });
  assert.equal(result.stderr, "");
});

test("CLI: version refuses missing embedded metadata without exposing its location", async () => {
  const result = await runSyntheticReleaseCli(["version"], undefined);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema_version: 0,
    status: "invalid",
    errors: [{ code: "release_manifest_invalid", message: "installed release manifest is unavailable or invalid" }],
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(result.root), false);
});