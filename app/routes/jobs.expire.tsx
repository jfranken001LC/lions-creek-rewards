// app/routes/jobs.expire.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { isAuthorizedJobRequest } from "../lib/jobAuth.server";
import { acquireJobLock, releaseJobLock } from "../lib/jobLock.server";
import { LedgerType, RedemptionStatus } from "@prisma/client";

const LOCK_NAME = "expire";
const LOCK_TTL_MS = 10 * 60 * 1000;

export async function loader({ request }: LoaderFunctionArgs) {
  // Allow a simple health check
  if (request.method === "GET") {
    return Response.json({ ok: true, route: "/jobs/expire" }, { headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  if (!isAuthorizedJobRequest(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const lock = await acquireJobLock(LOCK_NAME, LOCK_TTL_MS);
  if (!lock.acquired) {
    return Response.json(
      { ok: false, error: "lock_not_acquired", lockedUntil: lock.lockedUntil?.toISOString() ?? null },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const now = new Date();

  try {
    // 1) Restore points for expired-but-unused redemptions
    const expiredRedemptions = await db.redemption.findMany({
      where: {
        status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
        voidedAt: null,
        consumedAt: null,
        restoredAt: null,
        expiresAt: { lte: now },
      },
      take: 500,
      select: { id: true, shop: true, customerId: true, points: true },
    });

    let restoredCount = 0;
    for (const r of expiredRedemptions) {
      await db.$transaction(async (tx) => {
        // mark expired + restored
        await tx.redemption.update({
          where: { id: r.id },
          data: {
            status: RedemptionStatus.EXPIRED,
            expiredAt: now,
            restoredAt: now,
            restoreReason: "REDEMPTION_EXPIRED_UNUSED",
          },
        });

        // restore points to balance
        await tx.customerPointsBalance.update({
          where: { shop_customerId: { shop: r.shop, customerId: r.customerId } },
          data: {
            balance: { increment: r.points },
            lifetimeRedeemed: { decrement: r.points },
            // Treat as activity (prevents edge-case immediate inactivity expiry)
            lastActivityAt: now,
          },
        });

        // ledger entry (idempotent by unique key)
        await tx.pointsLedger.create({
          data: {
            shop: r.shop,
            customerId: r.customerId,
            type: LedgerType.ADJUST,
            delta: r.points,
            source: "REDEMPTION_EXPIRE",
            sourceId: r.id,
            description: `Restored ${r.points} points (unused redemption expired).`,
          },
        });
      }).catch(() => {
        // If it already ran (unique constraint), ignore
      });

      restoredCount++;
    }

    // 2) Inactivity expiry
    // Spec: expire after N days of inactivity (shop-level setting)
    const shops = await db.shopSettings.findMany({
      select: { shop: true, pointsExpireInactivityDays: true },
    });

    let inactivityExpiredCustomers = 0;

    for (const s of shops) {
      const days = s.pointsExpireInactivityDays ?? 365;
      const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

      const candidates = await db.customerPointsBalance.findMany({
        where: {
          shop: s.shop,
          balance: { gt: 0 },
          expiredAt: null,
          lastActivityAt: { lte: cutoff },
        },
        take: 500,
        select: { customerId: true, balance: true },
      });

      for (const c of candidates) {
        const amount = c.balance;
        await db.$transaction(async (tx) => {
          await tx.customerPointsBalance.update({
            where: { shop_customerId: { shop: s.shop, customerId: c.customerId } },
            data: {
              balance: 0,
              expiredAt: now,
            },
          });

          await tx.pointsLedger.create({
            data: {
              shop: s.shop,
              customerId: c.customerId,
              type: LedgerType.EXPIRY,
              delta: -amount,
              source: "INACTIVITY",
              sourceId: now.toISOString().slice(0, 10), // unique per day per customer due to composite unique
              description: `Expired ${amount} points after ${days} days of inactivity.`,
            },
          });
        }).catch(() => {
          // If already expired/ledgered, ignore
        });

        inactivityExpiredCustomers++;
      }
    }

    return Response.json(
      {
        ok: true,
        restoredExpiredRedemptions: restoredCount,
        expiredInactiveCustomers: inactivityExpiredCustomers,
        ranAt: now.toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    await releaseJobLock(LOCK_NAME);
  }
}
