import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import db from "../db.server";
import { acquireJobLock } from "../lib/jobLock.server";
import { assertJobAuth } from "../lib/jobAuth.server";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function action({ request }: ActionFunctionArgs) {
  // NOTE: keep the job name stable because it is part of the job token derivation.
  assertJobAuth(request, "jobs.expire");

  const release = await acquireJobLock("jobs.expire");
  try {
    const now = new Date();

    // ---------------------------------------------------------------------------------------------
    // 1) Expire ISSUED redemptions past `expiresAt` and restore points
    // ---------------------------------------------------------------------------------------------
    const toExpire = await db.redemption.findMany({
      where: {
        status: "ISSUED",
        expiresAt: { lte: now },
      },
      select: {
        id: true,
        shop: true,
        customerId: true,
        code: true,
        points: true,
      },
      take: 1000,
    });

    let redemptionsExpired = 0;

    for (const r of toExpire) {
      await db.$transaction(async (tx) => {
        // Mark as expired (guarded)
        const updated = await tx.redemption.updateMany({
          where: { id: r.id, status: "ISSUED" },
          data: { status: "EXPIRED", expiredAt: now },
        });

        if (updated.count === 0) return;

        // Idempotent ledger: if it already exists, DO NOT add balance again.
        await tx.pointsLedger.upsert({
          where: {
            ledger_dedupe: {
              shop: r.shop,
              customerId: r.customerId,
              type: "ADJUST",
              source: "REDEMPTION_EXPIRE_RESTORE",
              sourceId: r.id,
            },
          },
          create: {
            shop: r.shop,
            customerId: r.customerId,
            type: "ADJUST",
            delta: r.points,
            source: "REDEMPTION_EXPIRE_RESTORE",
            sourceId: r.id,
            description: `Restored points for expired redemption ${r.code}`,
          },
          update: {},
        });

        await tx.customerPointsBalance.upsert({
          where: { shop_customerId: { shop: r.shop, customerId: r.customerId } },
          create: {
            shop: r.shop,
            customerId: r.customerId,
            balance: r.points,
            lifetimeEarned: 0,
            lifetimeRedeemed: 0,
            lastActivityAt: now,
            expiredAt: null,
          },
          update: {
            balance: { increment: r.points },
            expiredAt: null,
          },
        });
      });

      redemptionsExpired += 1;
    }

    // ---------------------------------------------------------------------------------------------
    // 2) Expire points due to inactivity
    // ---------------------------------------------------------------------------------------------
    const shopsWithInactivityExpiry = await db.shopSettings.findMany({
      where: { pointsExpireInactivityDays: { gt: 0 } },
      select: { shop: true, pointsExpireInactivityDays: true },
    });

    let customersExpiredForInactivity = 0;

    for (const s of shopsWithInactivityExpiry) {
      const days = Number(s.pointsExpireInactivityDays ?? 0);
      if (!Number.isFinite(days) || days <= 0) continue;

      const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

      const staleBalances = await db.customerPointsBalance.findMany({
        where: {
          shop: s.shop,
          balance: { gt: 0 },
          expiredAt: null,
          lastActivityAt: { lt: cutoff },
        },
        select: { customerId: true, balance: true, lastActivityAt: true },
        take: 5000,
      });

      for (const b of staleBalances) {
        const sourceId = `${ymd(now)}:${b.customerId}`;
        const delta = -Math.abs(b.balance);

        await db.$transaction(async (tx) => {
          await tx.pointsLedger.upsert({
            where: {
              ledger_dedupe: {
                shop: s.shop,
                customerId: b.customerId,
                type: "EXPIRY",
                source: "INACTIVITY",
                sourceId,
              },
            },
            create: {
              shop: s.shop,
              customerId: b.customerId,
              type: "EXPIRY",
              delta,
              source: "INACTIVITY",
              sourceId,
              description: `Expired ${b.balance} points after ${days} days inactivity (last activity ${b.lastActivityAt.toISOString()})`,
            },
            update: {},
          });

          await tx.customerPointsBalance.updateMany({
            where: {
              shop: s.shop,
              customerId: b.customerId,
              balance: { gt: 0 },
            },
            data: {
              balance: 0,
              expiredAt: now,
            },
          });
        });

        customersExpiredForInactivity += 1;
      }
    }

    return data({
      ok: true,
      now: now.toISOString(),
      redemptionsExpired,
      customersExpiredForInactivity,
    });
  } finally {
    await release();
  }
}
