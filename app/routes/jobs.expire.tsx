import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { jobAuthFromRequest } from "../lib/jobAuth.server";
import { acquireJobLock, releaseJobLock } from "../lib/jobLock.server";

const INACTIVITY_EXPIRE_DAYS = 365;

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const auth = jobAuthFromRequest(request);
  if (!auth.ok) return new Response(auth.error, { status: 401 });

  const lock = await acquireJobLock("jobs.expire");
  if (!lock.ok) return new Response(lock.error, { status: 423 });

  try {
    const now = new Date();

    const expiredRedemptions = await db.redemption.updateMany({
      where: { status: "ACTIVE", expiresAt: { lte: now } },
      data: { status: "EXPIRED" },
    });

    const cutoff = new Date(now.getTime() - INACTIVITY_EXPIRE_DAYS * 24 * 60 * 60 * 1000);
    const staleBalances = await db.customerPointsBalance.findMany({
      where: {
        expiredAt: null,
        balance: { gt: 0 },
        lastActivityAt: { lt: cutoff },
      },
      select: { shop: true, customerId: true, balance: true },
      take: 500,
    });

    let expiredPointsCount = 0;

    for (const b of staleBalances) {
      await db.$transaction([
        db.pointsLedger.create({
          data: {
            shop: b.shop,
            customerId: b.customerId,
            delta: -b.balance,
            type: "EXPIRE",
            source: "SYSTEM",
            sourceId: `INACTIVITY_${INACTIVITY_EXPIRE_DAYS}D`,
            description: `Expired ${b.balance} points after ${INACTIVITY_EXPIRE_DAYS} days of inactivity.`,
          },
        }),
        db.customerPointsBalance.update({
          where: { shop_customerId: { shop: b.shop, customerId: b.customerId } },
          data: { balance: 0, expiredAt: now },
        }),
      ]);

      expiredPointsCount += 1;
    }

    return Response.json({
      ok: true,
      expiredRedemptions: expiredRedemptions.count,
      expiredPointBalances: expiredPointsCount,
    });
  } finally {
    await releaseJobLock("jobs.expire");
  }
}
