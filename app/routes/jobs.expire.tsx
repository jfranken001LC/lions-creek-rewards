// app/routes/jobs.expire.tsx
import type { ActionFunctionArgs } from "react-router";
import { json } from "react-router";
import db from "../db.server";
import { LedgerType, RedemptionStatus } from "@prisma/client";
import { authenticate } from "../shopify.server";

const INACTIVITY_DAYS = 365;
const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BATCH_SIZE = 200;

function daysAgo(d: number) {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}

function getProvidedJobToken(request: Request): string | null {
  const h = request.headers;
  const direct = h.get("x-job-token") || h.get("X-Job-Token");
  if (direct?.trim()) return direct.trim();

  const auth = h.get("authorization") || h.get("Authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

async function isAuthorized(request: Request): Promise<boolean> {
  const expected = (process.env.JOB_TOKEN ?? "").trim();
  const provided = getProvidedJobToken(request);

  if (expected && provided && provided === expected) return true;

  // Allow an authenticated admin session as a fallback
  try {
    await authenticate.admin(request);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(name: string) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + LOCK_TTL_MS);

  return db.$transaction(async (tx) => {
    const existing = await tx.jobLock.findUnique({ where: { name } });
    if (existing && existing.lockedUntil > now) {
      return { acquired: false, lockedUntil: existing.lockedUntil };
    }

    const up = await tx.jobLock.upsert({
      where: { name },
      create: { name, lockedAt: now, lockedUntil },
      update: { lockedAt: now, lockedUntil },
    });

    return { acquired: true, lockedUntil: up.lockedUntil };
  });
}

async function releaseLock(name: string) {
  const now = new Date();
  await db.jobLock
    .update({ where: { name }, data: { lockedUntil: now } })
    .catch(() => null);
}

async function expireUnusedRedemptions(now: Date) {
  let processed = 0;
  let restoredPoints = 0;

  while (true) {
    const batch = await db.redemption.findMany({
      where: {
        status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
        expiresAt: { lt: now },
      },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
      select: { id: true },
    });

    if (!batch.length) break;

    for (const r of batch) {
      const did = await db.$transaction(async (tx) => {
        const redemption = await tx.redemption.findUnique({
          where: { id: r.id },
          select: {
            id: true,
            shop: true,
            customerId: true,
            points: true,
            status: true,
            expiresAt: true,
            restoredAt: true,
          },
        });

        if (!redemption) return { restored: false, points: 0 };
        if (redemption.status !== RedemptionStatus.ISSUED && redemption.status !== RedemptionStatus.APPLIED) {
          return { restored: false, points: 0 };
        }

        // Idempotency guard: if ledger already exists for this redemption expiry, only mark redemption expired.
        const existingLedger = await tx.pointsLedger.findFirst({
          where: {
            shop: redemption.shop,
            customerId: redemption.customerId,
            type: LedgerType.ADJUST,
            source: "REDEMPTION_EXPIRE",
            sourceId: redemption.id,
          },
          select: { id: true },
        });

        if (existingLedger) {
          await tx.redemption.update({
            where: { id: redemption.id },
            data: {
              status: RedemptionStatus.EXPIRED,
              expiredAt: now,
              restoredAt: redemption.restoredAt ?? now,
              restoreReason: "EXPIRED_UNUSED",
            },
          });
          return { restored: false, points: 0 };
        }

        // Ensure balance row exists (rare, but safe)
        const bal = await tx.customerPointsBalance.upsert({
          where: {
            shop_customerId: {
              shop: redemption.shop,
              customerId: redemption.customerId,
            },
          },
          create: {
            shop: redemption.shop,
            customerId: redemption.customerId,
            balance: 0,
            lifetimeEarned: 0,
            lifetimeRedeemed: 0,
            lastActivityAt: now,
            expiredAt: null,
          },
          update: {},
          select: { lifetimeRedeemed: true },
        });

        const nextLifetimeRedeemed = Math.max(0, (bal?.lifetimeRedeemed ?? 0) - redemption.points);

        // 1) Mark redemption expired + restored
        await tx.redemption.update({
          where: { id: redemption.id },
          data: {
            status: RedemptionStatus.EXPIRED,
            expiredAt: now,
            restoredAt: now,
            restoreReason: "EXPIRED_UNUSED",
          },
        });

        // 2) Ledger entry
        await tx.pointsLedger.create({
          data: {
            shop: redemption.shop,
            customerId: redemption.customerId,
            type: LedgerType.ADJUST,
            delta: redemption.points,
            source: "REDEMPTION_EXPIRE",
            sourceId: redemption.id,
            description: `Restore ${redemption.points} pts (redemption expired unused)`,
          },
        });

        // 3) Restore balance + adjust lifetimeRedeemed downward
        await tx.customerPointsBalance.update({
          where: {
            shop_customerId: { shop: redemption.shop, customerId: redemption.customerId },
          },
          data: {
            balance: { increment: redemption.points },
            lifetimeRedeemed: nextLifetimeRedeemed,
            expiredAt: null,
          },
        });

        return { restored: true, points: redemption.points };
      });

      processed += 1;
      if (did.restored) restoredPoints += did.points;
    }
  }

  return { processed, restoredPoints };
}

async function expireInactivePoints(now: Date) {
  const cutoff = daysAgo(INACTIVITY_DAYS);

  let customersExpired = 0;
  let pointsExpired = 0;

  while (true) {
    const batch = await db.customerPointsBalance.findMany({
      where: {
        balance: { gt: 0 },
        lastActivityAt: { lt: cutoff },
        expiredAt: null,
      },
      orderBy: { lastActivityAt: "asc" },
      take: BATCH_SIZE,
      select: { id: true, shop: true, customerId: true, balance: true },
    });

    if (!batch.length) break;

    for (const row of batch) {
      await db.$transaction(async (tx) => {
        const fresh = await tx.customerPointsBalance.findUnique({
          where: { id: row.id },
          select: { shop: true, customerId: true, balance: true, expiredAt: true, lastActivityAt: true },
        });
        if (!fresh) return;
        if (fresh.expiredAt) return;
        if (!fresh.balance || fresh.balance <= 0) return;

        // Ledger idempotency via (shop, customerId, type, source, sourceId)
        // Use sourceId = balanceRow.id so it can only happen once.
        await tx.pointsLedger.create({
          data: {
            shop: fresh.shop,
            customerId: fresh.customerId,
            type: LedgerType.EXPIRY,
            delta: -fresh.balance,
            source: "INACTIVITY",
            sourceId: row.id,
            description: `Expired ${fresh.balance} pts due to ${INACTIVITY_DAYS} days inactivity.`,
          },
        });

        await tx.customerPointsBalance.update({
          where: { id: row.id },
          data: {
            balance: 0,
            expiredAt: now,
          },
        });

        customersExpired += 1;
        pointsExpired += fresh.balance;
      }).catch((e: any) => {
        // If ledger uniqueness trips (race), don't fail the whole job.
        const msg = String(e?.message ?? "");
        if (msg.toLowerCase().includes("unique constraint")) return;
        throw e;
      });
    }
  }

  return { customersExpired, pointsExpired };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const ok = await isAuthorized(request);
  if (!ok) return json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const lockName = "jobs.expire";
  const lock = await acquireLock(lockName);
  if (!lock.acquired) {
    return json(
      { ok: true, skipped: true, reason: "locked", lockedUntil: lock.lockedUntil.toISOString() },
      { status: 200 },
    );
  }

  const now = new Date();

  try {
    const redemptions = await expireUnusedRedemptions(now);
    const inactivity = await expireInactivePoints(now);

    return json(
      {
        ok: true,
        ranAt: now.toISOString(),
        redemptions,
        inactivity,
      },
      { status: 200 },
    );
  } finally {
    await releaseLock(lockName);
  }
};
