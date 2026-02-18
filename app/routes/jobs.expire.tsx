import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { assertJobAuth } from "../lib/jobAuth.server";
import { acquireJobLock, releaseJobLock } from "../lib/jobLock.server";
import { PointsLedgerType, RedemptionStatus } from "@prisma/client";

/**
 * POST /jobs/expire
 *
 * 1) Expire unused/expired redemptions.
 * 2) Restore points for those expired redemptions.
 *
 * Protected by JOB_TOKEN.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  await assertJobAuth(request, "jobs.expire");

  const lock = await acquireJobLock("jobs.expire", 2 * 60 * 1000);
  if (!lock.acquired) {
    return Response.json(
      { ok: false, error: lock.error },
      { status: 423 },
    );
  }

  const now = new Date();

  try {
    // Find expirable redemptions first so we can restore points accurately.
    const expirable = await db.redemption.findMany({
      where: {
        expiresAt: { lt: now },
        status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      },
      select: {
        id: true,
        shop: true,
        customerId: true,
        points: true,
        code: true,
        expiresAt: true,
        status: true,
      },
    });

    let expiredCount = 0;
    let pointsRestored = 0;

    // Use a transaction to keep balance + ledger + redemption status consistent.
    await db.$transaction(async (tx) => {
      for (const r of expirable) {
        // Guard against double-processing if another worker already updated it.
        const updated = await tx.redemption.updateMany({
          where: {
            id: r.id,
            status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
          },
          data: { status: RedemptionStatus.EXPIRED },
        });

        if (updated.count !== 1) continue;

        expiredCount += 1;
        pointsRestored += r.points;

        // Ensure a balance row exists.
        await tx.customerPointsBalance.upsert({
          where: {
            shop_customerId: { shop: r.shop, customerId: r.customerId },
          },
          create: {
            shop: r.shop,
            customerId: r.customerId,
            balance: r.points,
            lifetimeEarned: 0,
            lifetimeRedeemed: 0,
            lastActivityAt: now,
          },
          update: {
            balance: { increment: r.points },
            lastActivityAt: now,
          },
        });

        await tx.pointsLedger.create({
          data: {
            shop: r.shop,
            customerId: r.customerId,
            type: PointsLedgerType.EXPIRE,
            delta: r.points,
            notes: `Expiry restore for redemption ${r.id} (code ${r.code})`,
          },
        });
      }
    });

    return Response.json({
      ok: true,
      now: now.toISOString(),
      expiredRedemptions: expiredCount,
      pointsRestored,
    });
  } finally {
    await releaseJobLock("jobs.expire", lock.lockId);
  }
}
