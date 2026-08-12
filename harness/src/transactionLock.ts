import { link, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ActiveSpace } from "./spaceRegistry.ts";
import type { KnowledgeResult } from "./knowledgeTypes.ts";

type LockOwner = {
  schema_version: 0;
  pid: number;
  hostname: string;
  token: string;
};

export type TransactionLock = {
  state: "acquired" | "recovered";
  release: () => Promise<void>;
};

export type TransactionLockHooks = {
  afterExistingOwnerRead?: () => Promise<void>;
};

export function transactionLockDirectory(binding: ActiveSpace): string {
  return join(binding.spaceRoot, ".engram-knowledge-transaction.lock");
}

function lockError<T>(code: string, message: string): KnowledgeResult<T> {
  return { ok: false, errors: [{ kind: "lock", code, message }] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

async function readOwner(path: string): Promise<KnowledgeResult<LockOwner>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(parsed) || parsed.schema_version !== 0 || typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.hostname !== "string" || parsed.hostname.length === 0 || typeof parsed.token !== "string" || parsed.token.length === 0) {
      return { ok: false, errors: [{ kind: "lock", code: "lock_owner_unverifiable", message: "transaction lock owner metadata is malformed" }] };
    }
    return { ok: true, value: { schema_version: 0, pid: parsed.pid, hostname: parsed.hostname, token: parsed.token } };
  } catch (error) {
    return { ok: false, errors: [{ kind: "lock", code: "lock_owner_unverifiable", message: `transaction lock owner metadata could not be read: ${error instanceof Error ? error.message : String(error)}` }] };
  }
}

function processState(pid: number): "live" | "absent" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "absent" : "unknown";
  }
}

async function installExclusiveOwnerMetadata(ownerPath: string, owner: LockOwner): Promise<KnowledgeResult<boolean>> {
  const candidatePath = `${ownerPath}.candidate-${owner.pid}-${owner.token}`;
  try {
    await writeFile(candidatePath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await link(candidatePath, ownerPath);
      return { ok: true, value: true };
    } catch (error) {
      if (errorCode(error) === "EEXIST") return { ok: true, value: false };
      return { ok: false, errors: [{ kind: "lock", code: "lock_install_failed", message: `transaction lock owner metadata could not be installed: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  } catch (error) {
    return { ok: false, errors: [{ kind: "lock", code: "lock_install_failed", message: `transaction lock owner metadata could not be prepared: ${error instanceof Error ? error.message : String(error)}` }] };
  } finally {
    await unlink(candidatePath).catch(() => {});
  }
}

async function installLock(path: string, state: "acquired" | "recovered"): Promise<KnowledgeResult<TransactionLock>> {
  const owner: LockOwner = { schema_version: 0, pid: process.pid, hostname: hostname(), token: randomUUID() };
  const installed = await installExclusiveOwnerMetadata(join(path, "owner.json"), owner);
  if (!installed.ok) return installed;
  if (!installed.value) return lockError("lock_install_failed", "transaction lock owner metadata already exists");
  return {
    ok: true,
    value: {
      state,
      release: async () => {
        const current = await readOwner(join(path, "owner.json"));
        if (!current.ok || current.value.token !== owner.token) return;
        await rm(path, { recursive: true, force: false }).catch(() => {});
      },
    },
  };
}

async function clearStaleRecoveryMarker(path: string): Promise<KnowledgeResult<void>> {
  try {
    await stat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, value: undefined };
    return { ok: false, errors: [{ kind: "lock", code: "lock_recovery_failed", message: "transaction lock recovery marker could not be inspected" }] };
  }

  const owner = await readOwner(path);
  if (!owner.ok) return { ok: false, errors: owner.errors };
  if (owner.value.hostname !== hostname()) {
    return lockError("lock_conflict", `transaction lock recovery is held by another host (${owner.value.hostname})`);
  }
  const state = processState(owner.value.pid);
  if (state === "live") return lockError("lock_conflict", `transaction lock recovery is held by process ${owner.value.pid}`);
  if (state === "unknown") return lockError("lock_owner_unverifiable", `transaction lock recovery owner process ${owner.value.pid} cannot be verified as absent`);
  try {
    await unlink(path);
    return { ok: true, value: undefined };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, value: undefined };
    return { ok: false, errors: [{ kind: "lock", code: "lock_recovery_failed", message: "transaction lock recovery marker changed while it was being inspected" }] };
  }
}

async function recoverProvenStaleLock(
  path: string,
  recoveryPath: string,
  expectedOwner: LockOwner,
): Promise<KnowledgeResult<void>> {
  const recoveryOwner: LockOwner = { schema_version: 0, pid: process.pid, hostname: hostname(), token: randomUUID() };
  const installed = await installExclusiveOwnerMetadata(recoveryPath, recoveryOwner);
  if (!installed.ok) return { ok: false, errors: installed.errors };
  if (!installed.value) return { ok: false, errors: [{ kind: "lock", code: "lock_conflict", message: "transaction lock stale recovery is already in progress" }] };

  try {
    const current = await readOwner(join(path, "owner.json"));
    if (!current.ok) return { ok: false, errors: current.errors };
    if (current.value.pid !== expectedOwner.pid || current.value.hostname !== expectedOwner.hostname || current.value.token !== expectedOwner.token) {
      return { ok: false, errors: [{ kind: "lock", code: "lock_conflict", message: "transaction lock ownership changed during stale recovery" }] };
    }
    if (current.value.hostname !== hostname()) {
      return { ok: false, errors: [{ kind: "lock", code: "lock_conflict", message: `transaction lock changed to another host (${current.value.hostname}) during stale recovery` }] };
    }
    const state = processState(current.value.pid);
    if (state === "live") return { ok: false, errors: [{ kind: "lock", code: "lock_conflict", message: `transaction lock owner process ${current.value.pid} became live during stale recovery` }] };
    if (state === "unknown") return { ok: false, errors: [{ kind: "lock", code: "lock_owner_unverifiable", message: `transaction lock owner process ${current.value.pid} cannot be verified as absent` }] };
    try {
      await rm(path, { recursive: true, force: false });
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, errors: [{ kind: "lock", code: "lock_recovery_failed", message: `transaction lock stale recovery failed: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  } finally {
    const currentRecoveryOwner = await readOwner(recoveryPath);
    if (currentRecoveryOwner.ok && currentRecoveryOwner.value.token === recoveryOwner.token) await unlink(recoveryPath).catch(() => {});
  }
}

export async function acquireTransactionLock(binding: ActiveSpace, hooks?: TransactionLockHooks): Promise<KnowledgeResult<TransactionLock>> {
  const path = transactionLockDirectory(binding);
  const recoveryPath = `${path}.recovery`;
  try {
    await mkdir(path);
    return installLock(path, "acquired");
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      return lockError("lock_acquire_failed", `transaction lock could not be acquired: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const cleared = await clearStaleRecoveryMarker(recoveryPath);
  if (!cleared.ok) return cleared;
  const owner = await readOwner(join(path, "owner.json"));
  if (!owner.ok) return owner;
  if (hooks?.afterExistingOwnerRead !== undefined) await hooks.afterExistingOwnerRead();
  if (owner.value.hostname !== hostname()) {
    return lockError("lock_conflict", `transaction lock is held by another host (${owner.value.hostname})`);
  }
  const state = processState(owner.value.pid);
  if (state === "live") return lockError("lock_conflict", `transaction lock is held by process ${owner.value.pid}`);
  if (state === "unknown") return lockError("lock_owner_unverifiable", `transaction lock owner process ${owner.value.pid} cannot be verified as absent`);

  const recovered = await recoverProvenStaleLock(path, recoveryPath, owner.value);
  if (!recovered.ok) return recovered;
  try {
    await mkdir(path);
  } catch (error) {
    return lockError("lock_conflict", `transaction lock changed during stale recovery: ${error instanceof Error ? error.message : String(error)}`);
  }
  return installLock(path, "recovered");
}
