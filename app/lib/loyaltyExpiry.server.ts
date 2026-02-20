import db from "../db.server";
import { LedgerType, RedemptionStatus } from "@prisma/client";
import { getOrCreateShopSettings } from "./shopSettings.server";

export type ExpireIssuedRedemptionsResult = {
  expiredCount: number;
};

export type ExpireInactiveCustomersResult = {
  scannedCount: number;
  expiredCustomersCount: number;
  totalPointsExpired: number;
};

export async function expireIssuedRedemptions(args: {
  shop: string;
  now: Date;
}): Promise<ExpireIssuedRedemptionsResult> {
  const shop = String(args.shop || "").trim();
  const now = args.now instanceof Date ? args.now : new Date();

  if (!shop) throw new Error("shop is required");

  // Mark ISSUED/APPLIED redemptions as EXPIRED when past expiresAt.
  // (No points restoration here — requirements v1.4 doesn’t specify restore-on-expire;
  // leaving that as an explicit future decision to avoid silent ledger side-effects.)
  const updated = await db.redemption.updateMany({
    where: {
      shop,
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      expiresAt: { not: null, lte: now },
      expiredAt: null,
    },
    data: {
      status: RedemptionStatus.EXPIRED,
      expiredAt: now,
    },
  });

  return { expiredCount: updated.count };
}

export async function expireInactiveCustomers(args: {
  shop: string;
  now: Date;
  batchSize?: number;
}): Promise<ExpireInactiveCustomersResult> {
  const shop = String(args.shop || "").trim();
  const now = args.now instanceof Date ? args.now : new Date();
  const batchSize = Number.isFinite(args.batchSize) ? Math.max(1, Math.floor(args.batchSize as number)) : 250;

  if (!shop) throw new Error("shop is required");

  const settings = await getOrCreateShopSettings(shop);
  const inactivityDays = Math.max(1, Math.floor(settings.pointsExpireInactivityDays || 365));
  const cutoff = new Date(now.getTime() - inactivityDays * 24 * 60 * 60 * 1000);

  // Find candidates (not yet expired, positive balance, inactive past cutoff)
  const candidates = await db.customerPointsBalance.findMany({
    where: {
      shop,
      expiredAt: null,
      balance: { gt: 0 },
      lastActivityAt: { lte: cutoff },
    },
    orderBy: { lastActivityAt: "asc" },
    take: batchSize,
    select: {
      customerId: true,
      balance: true,
      lastActivityAt: true,
    },
  });

  let expiredCustomersCount = 0;
  let totalPointsExpired = 0;

  // Use a run key to make the ledger entry deterministic per day
  const runKey = now.toISOString().slice(0, 10); // YYYY-MM-DD

  for (const c of candidates) {
    const customerId = c.customerId;
    const pointsToExpire = Math.max(0, Math.floor(c.balance || 0));
    if (!customerId || pointsToExpire <= 0) continue;

    await db.$transaction(async (tx) => {
      // Re-check eligibility inside the transaction to be safe under concurrent earn/redeem activity.
      const current = await tx.customerPointsBalance.findUnique({
        where: { shop_customerId: { shop, customerId } },
        select: { balance: true, expiredAt: true, lastActivityAt: true },
      });

      if (!current) return;
      if (current.expiredAt) return;
      if (!current.balance || current.balance <= 0) return;
      if (current.lastActivityAt > cutoff) return;

      // IMPORTANT: PointsLedger also has a shop-wide unique constraint on (shop, type, source, sourceId),
      // so sourceId MUST be unique per customer to avoid collisions.
      const source = "INACTIVITY";
      const sourceId = `INACTIVITY:${customerId}:${runKey}`;

      // Best-effort ledger entry (idempotent under retries)
      try {
        await tx.pointsLedger.create({
          data: {
            shop,
            customerId,
            type: LedgerType.EXPIRY,
            delta: -current.balance,
            source,
            sourceId,
            description: `Expired ${current.balance} point(s) after ${inactivityDays} days of inactivity.`,
          },
        });
      } catch (err: any) {
        // If it already exists (P2002), proceed to balance update anyway.
        if (err?.code !== "P2002") throw err;
      }

      // Expire the balance (only if still eligible)
      const updated = await tx.customerPointsBalance.updateMany({
        where: {
          shop,
          customerId,
          expiredAt: null,
          balance: { gt: 0 },
          lastActivityAt: { lte: cutoff },
        },
        data: {
          balance: 0,
          expiredAt: now,
        },
      });

      if (updated.count > 0) {
        expiredCustomersCount += 1;
        totalPointsExpired += current.balance;
      }
    });
  }

  return {
    scannedCount: candidates.length,
    expiredCustomersCount,
    totalPointsExpired,
  };
}
