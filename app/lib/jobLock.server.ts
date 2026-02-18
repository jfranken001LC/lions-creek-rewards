// app/lib/jobLock.server.ts
import db from "../db.server";

export type JobLockResult =
  | { acquired: true; lockedUntil: Date }
  | { acquired: false; lockedUntil: Date | null };

/**
 * Simple DB-backed lock to ensure only one job runner executes a named job at a time.
 * Uses the JobLock Prisma model.
 */
export async function acquireJobLock(
  name: string,
  ttlMs: number,
): Promise<JobLockResult> {
  const now = new Date();
  const nextUntil = new Date(now.getTime() + ttlMs);

  return db.$transaction(async (tx) => {
    const existing = await tx.jobLock.findUnique({ where: { name } });

    if (!existing) {
      await tx.jobLock.create({
        data: { name, lockedUntil: nextUntil },
      });
      return { acquired: true as const, lockedUntil: nextUntil };
    }

    if (existing.lockedUntil <= now) {
      await tx.jobLock.update({
        where: { name },
        data: { lockedUntil: nextUntil },
      });
      return { acquired: true as const, lockedUntil: nextUntil };
    }

    return { acquired: false as const, lockedUntil: existing.lockedUntil };
  });
}

export async function releaseJobLock(name: string) {
  const now = new Date();
  await db.jobLock
    .update({ where: { name }, data: { lockedUntil: now } })
    .catch(() => {
      // ignore if missing
    });
}
