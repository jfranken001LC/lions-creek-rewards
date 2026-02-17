import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { assertJobAuth, isJobTokenValid } from "../lib/jobAuth.server";
import { RedemptionStatus, LedgerType } from "@prisma/client";

function jsonResponse(payload: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function getJobTokenFromQuery(request: Request) {
  const url = new URL(request.url);
  return url.searchParams.get("token");
}

async function assertJobAuthCompat(request: Request) {
  try {
    await assertJobAuth(request, "jobs.expire");
    return;
  } catch (e: any) {
    const token = getJobTokenFromQuery(request);
    if (token && isJobTokenValid(token)) return;
    throw e;
  }
}

async function acquireJobLock(lockKey: string, ttlMs: number) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + ttlMs);
  const lockedBy = `${process.env.HOSTNAME ?? "host"}:${process.pid}`;

  return db.$transaction(async (tx) => {
    const existing = await tx.jobLock.findUnique({ where: { lockKey } });
    if (existing && existing.lockedUntil > now) return { acquired: false, existing } as const;

    const lock = await tx.jobLock.upsert({
      where: { lockKey },
      create: { lockKey, lockedUntil, lockedBy },
      update: { lockedUntil, lockedBy },
    });

    return { acquired: true, lock } as const;
  });
}

async function releaseJobLock(lockKey: string) {
  const now = new Date();
  await db.jobLock.update({ where: { lockKey }, data: { lockedUntil: now } }).catch(() => undefined);
}

async function restoreExpiredUnconsumedRedemptions(now: Date, limit = 250) {
  const candidates = await db.redemption.findMany({
    where: {
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      expiresAt: { lt: now },
      consumedAt: null,
      voidedAt: null,
      expiredAt: null,
      cancelledAt: null,
    },
    orderBy: { expiresAt: "asc" },
    take: limit,
    select: { id: true, shop: true, customerId: true, points: true },
  });

  let restoredCount = 0;
  let pointsRestored = 0;

  for (const r of candidates) {
    await db.$transaction(async (tx) => {
      const current = await tx.redemption.findUnique({
        where: { id: r.id },
        select: {
          id: true,
          shop: true,
          customerId: true,
          points: true,
          status: true,
          consumedAt: true,
          voidedAt: true,
          expiredAt: true,
          cancelledAt: true,
        },
      });

      if (!current) return;
      if (current.consumedAt || current.voidedAt || current.expiredAt || current.cancelledAt) return;
      if (![RedemptionStatus.ISSUED, RedemptionStatus.APPLIED].includes(current.status)) return;

      const bal = await tx.customerPointsBalance.findUnique({
        where: { shop_customerId: { shop: current.shop, customerId: current.customerId } },
      });

      const lifetimeRedeemed = bal?.lifetimeRedeemed ?? 0;
      const newLifetimeRedeemed = Math.max(0, lifetimeRedeemed - current.points);

      await tx.redemption.update({
        where: { id: current.id },
        data: {
          status: RedemptionStatus.EXPIRED,
          expiredAt: now,
          restoredAt: now,
          restoreReason: "DISCOUNT_CODE_EXPIRED_UNUSED",
        },
      });

      await tx.customerPointsBalance.upsert({
        where: { shop_customerId: { shop: current.shop, customerId: current.customerId } },
        create: {
          shop: current.shop,
          customerId: current.customerId,
          balance: current.points,
          lifetimeEarned: 0,
          lifetimeRedeemed: 0,
          lastActivityAt: now,
          expiredAt: null,
        },
        update: {
          balance: { increment: current.points },
          lifetimeRedeemed: newLifetimeRedeemed,
          expiredAt: null,
        },
      });

      await tx.pointsLedger.create({
        data: {
          shop: current.shop,
          customerId: current.customerId,
          type: LedgerType.ADJUST,
          delta: current.points,
          source: "JOB_REDEMPTION_EXPIRE_RESTORE",
          sourceId: current.id,
          description: `Restored ${current.points} points from expired unused redemption`,
        },
      });

      restoredCount += 1;
      pointsRestored += current.points;
    });
  }

  return { restoredCount, pointsRestored };
}

async function expireInactiveBalances(now: Date, inactiveDays = 365, limit = 500) {
  const cutoff = new Date(now.getTime() - inactiveDays * 24 * 60 * 60 * 1000);

  const candidates = await db.customerPointsBalance.findMany({
    where: { balance: { gt: 0 }, expiredAt: null, lastActivityAt: { lt: cutoff } },
    orderBy: { lastActivityAt: "asc" },
    take: limit,
    select: { shop: true, customerId: true },
  });

  let expiredCount = 0;
  let pointsExpired = 0;

  for (const c of candidates) {
    await db.$transaction(async (tx) => {
      const cur = await tx.customerPointsBalance.findUnique({
        where: { shop_customerId: { shop: c.shop, customerId: c.customerId } },
        select: { balance: true, expiredAt: true },
      });

      if (!cur || cur.expiredAt || cur.balance <= 0) return;

      await tx.customerPointsBalance.update({
        where: { shop_customerId: { shop: c.shop, customerId: c.customerId } },
        data: { balance: 0, expiredAt: now },
      });

      await tx.pointsLedger.create({
        data: {
          shop: c.shop,
          customerId: c.customerId,
          type: LedgerType.EXPIRE,
          delta: -cur.balance,
          source: "JOB_POINTS_INACTIVITY_EXPIRE",
          description: `Expired ${cur.balance} points due to inactivity`,
        },
      });

      expiredCount += 1;
      pointsExpired += cur.balance;
    });
  }

  return { expiredCount, pointsExpired, cutoff };
}

async function runExpireJob(request: Request) {
  await assertJobAuthCompat(request);

  const startedAt = Date.now();
  const now = new Date();

  const lockKey = "points_expiry";
  const lock = await acquireJobLock(lockKey, 15 * 60 * 1000);

  if (!lock.acquired) {
    return jsonResponse(
      {
        ok: false,
        error: "Job already running",
        lock: { lockedUntil: lock.existing.lockedUntil, lockedBy: lock.existing.lockedBy },
      },
      { status: 409 }
    );
  }

  try {
    const restored = await restoreExpiredUnconsumedRedemptions(now);
    const expired = await expireInactiveBalances(now, 365);
    const tookMs = Date.now() - startedAt;

    return jsonResponse({
      ok: true,
      now: now.toISOString(),
      restored,
      expired: {
        expiredCount: expired.expiredCount,
        pointsExpired: expired.pointsExpired,
        cutoff: expired.cutoff.toISOString(),
      },
      tookMs,
    });
  } finally {
    await releaseJobLock(lockKey);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  return runExpireJob(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return runExpireJob(request);
}
