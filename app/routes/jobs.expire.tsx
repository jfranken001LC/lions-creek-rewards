import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { assertJobAuth } from "../lib/jobAuth.server";
import { acquireJobLock, releaseJobLock } from "../lib/jobLock.server";

// @prisma/client is CommonJS. Vite SSR may rewrite named imports, so keep it as a default import.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import prismaPkg from "@prisma/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { LedgerType, RedemptionStatus } = prismaPkg as any;

export async function action({ request }: ActionFunctionArgs) {
  assertJobAuth(request);

  // P1: concurrency-safe job lock (cross-process on same host)
  const lock = await acquireJobLock("jobs.expire", 5 * 60 * 1000);
  if (!lock.acquired) {
    return Response.json({ ok: true, skipped: true, reason: lock.error });
  }

  const now = new Date();

  try {
    // Expire up to N redemptions per run (safe to call repeatedly)
    const expiring = await db.redemption.findMany({
      where: {
        status: RedemptionStatus.ISSUED,
        expiresAt: { lt: now },
      },
      take: 250,
      select: {
        id: true,
        shop: true,
        customerId: true,
        points: true,
        code: true,
      },
    });

    let expiredCount = 0;

    for (const r of expiring) {
      // Idempotent transition: only ISSUED -> EXPIRED
      const updated = await db.redemption.updateMany({
        where: { id: r.id, status: RedemptionStatus.ISSUED },
        data: {
          status: RedemptionStatus.EXPIRED,
          expiredAt: now,
          restoredAt: now,
          restoreReason: "Expired (auto)",
        },
      });

      if (updated.count !== 1) continue;

      // Restore points + ledger entry atomically
      await db.$transaction(async (tx) => {
        await tx.customerPointsBalance.upsert({
          where: { shop_customerId: { shop: r.shop, customerId: r.customerId } },
          create: {
            shop: r.shop,
            customerId: r.customerId,
            balance: r.points,
            lastActivityAt: now,
            expiredAt: null,
          },
          update: {
            balance: { increment: r.points },
            lastActivityAt: now,
            expiredAt: null,
          },
        });

        // Ledger is immutable; unique constraint prevents duplicates across retries
        await tx.pointsLedger.create({
          data: {
            shop: r.shop,
            customerId: r.customerId,
            type: LedgerType.EXPIRY,
            delta: r.points,
            source: "REDEMPTION",
            sourceId: r.id,
            description: `Redemption expired; points restored (${r.code})`,
          },
        });
      });

      expiredCount++;
    }

    return Response.json({ ok: true, expiredCount });
  } finally {
    await releaseJobLock("jobs.expire", lock.lockId);
  }
}
