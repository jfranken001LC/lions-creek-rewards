import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type JobLockResult =
  | { acquired: true; lockId: string; expiresAt: Date }
  | { acquired: false; error: string };

/**
 * Lightweight cross-process job lock using an exclusive lock file.
 *
 * Why file locks?
 * - Works even if Prisma schema doesn't include a JobLock model.
 * - Survives multiple Node processes on the same host.
 * - TTL-based cleanup prevents permanent deadlocks.
 */
const LOCK_DIR =
  process.env.JOB_LOCK_DIR?.trim() ||
  path.join(os.tmpdir(), "lions-creek-rewards-job-locks");

function lockPath(name: string) {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(LOCK_DIR, `${safe}.lock.json`);
}

async function readLock(file: string): Promise<null | { lockId: string; expiresAt: string }> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.lockId !== "string" || typeof parsed.expiresAt !== "string") return null;
    return { lockId: parsed.lockId, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export async function acquireJobLock(name: string, ttlMs = 2 * 60 * 1000): Promise<JobLockResult> {
  await fs.mkdir(LOCK_DIR, { recursive: true });

  const file = lockPath(name);
  const now = Date.now();
  const lockId = crypto.randomUUID();
  const expiresAt = new Date(now + Math.max(10_000, ttlMs));
  const payload = JSON.stringify({ lockId, expiresAt: expiresAt.toISOString() });

  // First attempt: exclusive create
  try {
    const fh = await fs.open(file, "wx");
    try {
      await fh.writeFile(payload, "utf8");
    } finally {
      await fh.close();
    }
    return { acquired: true, lockId, expiresAt };
  } catch (e: any) {
    // If exists, check for staleness
    if (e?.code !== "EEXIST") {
      return { acquired: false, error: `Unable to create lock file: ${String(e?.message || e)}` };
    }
  }

  // File exists - see if stale
  const existing = await readLock(file);
  if (existing) {
    const existingExpires = Date.parse(existing.expiresAt);
    if (Number.isFinite(existingExpires) && existingExpires > now) {
      return { acquired: false, error: "Job already running (lock active)." };
    }
  }

  // Stale (or unreadable) - attempt cleanup and one retry
  try {
    await fs.unlink(file);
  } catch {
    // ignore
  }

  try {
    const fh = await fs.open(file, "wx");
    try {
      await fh.writeFile(payload, "utf8");
    } finally {
      await fh.close();
    }
    return { acquired: true, lockId, expiresAt };
  } catch {
    return { acquired: false, error: "Job already running (lock contention)." };
  }
}

export async function releaseJobLock(name: string, lockId?: string): Promise<void> {
  const file = lockPath(name);

  // If caller provided lockId, only remove if it matches (best-effort safety)
  if (lockId) {
    const existing = await readLock(file);
    if (existing && existing.lockId && existing.lockId !== lockId) return;
  }

  try {
    await fs.unlink(file);
  } catch {
    // ignore
  }
}
