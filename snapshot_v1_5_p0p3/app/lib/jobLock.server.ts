import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type JobLockResult = {
  acquired: boolean;
  /** A unique identifier for this lock acquisition attempt (only set when acquired). */
  lockId?: string;
  /** Absolute path to the lock file (only set when acquired). */
  lockPath?: string;
  /** Human-readable error (only set when not acquired). */
  error?: string;
};

/**
 * File-based job lock (v1.4 default)
 *
 * Key learning (v1.4): avoid schema drift for background/cron jobs.
 * We intentionally do NOT require a JobLock DB table.
 *
 * Notes:
 * - Suitable for single-instance deployments (e.g., Lightsail).
 * - Uses a TTL to recover from crashes (stale lock files).
 */
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function acquireJobLock(jobName: string, ttlMs: number = DEFAULT_TTL_MS): Promise<JobLockResult> {
  const lockPath = getLockPath(jobName);
  const now = Date.now();

  // First, clear stale locks (best-effort).
  await clearStaleLock(lockPath, ttlMs, now);

  // Try to create an exclusive lock file.
  const lockId = randomUUID();
  const payload = JSON.stringify(
    {
      lockId,
      jobName,
      pid: process.pid,
      createdAtMs: now,
    },
    null,
    0,
  );

  try {
    const handle = await open(lockPath, "wx"); // fail if exists
    try {
      await handle.writeFile(payload, { encoding: "utf-8" });
    } finally {
      await handle.close();
    }

    return { acquired: true, lockId, lockPath };
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      return { acquired: false, error: "Job lock already held." };
    }
    throw err;
  }
}

export async function releaseJobLock(lock: JobLockResult): Promise<void> {
  if (!lock.acquired || !lock.lockPath || !lock.lockId) return;

  try {
    // Only release if we still own the lock (lockId matches).
    const raw = await readFile(lock.lockPath, { encoding: "utf-8" }).catch(() => "");
    if (!raw) return;

    const parsed = safeJsonParse(raw);
    if (parsed?.lockId && parsed.lockId !== lock.lockId) {
      // Another process replaced the lock (stale recovery). Do not remove.
      return;
    }

    await unlink(lock.lockPath).catch(() => {});
  } catch {
    // best-effort release
  }
}

function getLockPath(jobName: string): string {
  const safe = String(jobName ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_");

  return path.join(os.tmpdir(), `lcr-joblock-${safe}.lock`);
}

async function clearStaleLock(lockPath: string, ttlMs: number, nowMs: number): Promise<void> {
  try {
    const raw = await readFile(lockPath, { encoding: "utf-8" });
    const parsed = safeJsonParse(raw);

    const createdAtMs = Number(parsed?.createdAtMs);
    if (!Number.isFinite(createdAtMs)) {
      // Corrupt lock file -> remove.
      await unlink(lockPath).catch(() => {});
      return;
    }

    if (nowMs - createdAtMs > ttlMs) {
      // Stale lock -> remove.
      await unlink(lockPath).catch(() => {});
      return;
    }
  } catch (err: any) {
    // If file doesn't exist, nothing to do.
    if (err?.code === "ENOENT") return;
    // Anything else: best-effort; don't block acquisition.
  }
}

function safeJsonParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
