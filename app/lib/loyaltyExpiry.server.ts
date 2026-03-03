import db from "../db.server";
import { LedgerType, RedemptionStatus } from "@prisma/client";
import { getOrCreateShopSettings } from "./shopSettings.server";

export type ExpireIssuedRedemptionsResult = {
  scannedCount: number;
  expiredCount: number;
  restoredCount: number;
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

  // v1.8: Redemptions created in Cart are "pending" (discount code minted + points debited),
  // and MUST be restored if the redemption is abandoned (expired/voided/cancelled) without an order consuming it.
  //
  // We keep this job idempotent by:
  // - only restoring when restoredAt is null
  // - using the PointsLedger compound unique key (ledger_dedupe) as the guardrail
  // - setting restoredAt + restoreReason on the redemption record

  const toExpire = await db.redemption.findMany({
    where: {
      shop,
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      expiresAt: { not: null, lte: now },
      expiredAt: null,
    },
    select: {
      id: true,
      customerId: true,
      points: true,
      status: true,
      expiresAt: true,
      consumedAt: true,
      consumedOrderId: true,
      restoredAt: true,
    },
    orderBy: { expiresAt: "asc" },
    take: 500,
  });

  let expiredCount = 0;
  let restoredCount = 0;

  for (const r of toExpire) {
    await db.$transaction(async (tx) => {
      // Mark expired (idempotent by virtue of initial query filter)
      await tx.redemption.update({
        where: { id: r.id },
        data: { status: RedemptionStatus.EXPIRED, expiredAt: now },
      });

      expiredCount += 1;

      const isConsumed = Boolean(r.consumedAt || r.consumedOrderId);
      if (isConsumed) return;
      if (r.restoredAt) return;

      // Ledger guardrail: only restore once.
      const key = {
        shop,
        customerId: r.customerId,
        type: LedgerType.REVERSAL,
        source: "REDEEM_EXPIRE",
        sourceId: r.id,
      } as const;

      const existing = await tx.pointsLedger.findUnique({
        where: { ledger_dedupe: key },
        select: { id: true },
      });

      if (existing) return;

      await tx.pointsLedger.create({
        data: {
          shop,
          customerId: r.customerId,
          type: LedgerType.REVERSAL,
          delta: Math.abs(r.points),
          source: "REDEEM_EXPIRE",
          sourceId: r.id,
          description: `Restored ${r.points} point(s) for expired redemption.`,
        },
      });

      await tx.customerPointsBalance.upsert({
        where: { shop_customerId: { shop, customerId: r.customerId } },
        create: {
          shop,
          customerId: r.customerId,
          balance: Math.abs(r.points),
          lifetimeEarned: 0,
          lifetimeRedeemed: 0,
          lastActivityAt: now,
        },
        update: {
          balance: { increment: Math.abs(r.points) },
          lifetimeRedeemed: { decrement: Math.abs(r.points) },
          lastActivityAt: now,
        },
      });

      await tx.redemption.update({
        where: { id: r.id },
        data: { restoredAt: now, restoreReason: "EXPIRED_UNCONSUMED" },
      });

      restoredCount += 1;
    });
  }

  // Also sweep VOID/CANCELLED (and any EXPIRED that didn't get restored earlier) for restoration.
  const other = await db.redemption.findMany({
    where: {
      shop,
      status: { in: [RedemptionStatus.EXPIRED, RedemptionStatus.VOID, RedemptionStatus.CANCELLED] },
      restoredAt: null,
      consumedAt: null,
      consumedOrderId: null,
    },
    select: { id: true, customerId: true, points: true, status: true },
    orderBy: { updatedAt: "asc" },
    take: 500,
  });

  for (const r of other) {
    await db.$transaction(async (tx) => {
      const reason =
        r.status === RedemptionStatus.VOID
          ? "VOID"
          : r.status === RedemptionStatus.CANCELLED
            ? "CANCELLED"
            : "EXPIRED";

      const key = {
        shop,
        customerId: r.customerId,
        type: LedgerType.REVERSAL,
        source: "REDEEM_RESTORE",
        sourceId: r.id,
      } as const;

      const existing = await tx.pointsLedger.findUnique({
        where: { ledger_dedupe: key },
        select: { id: true },
      });
      if (existing) return;

      await tx.pointsLedger.create({
        data: {
          shop,
          customerId: r.customerId,
          type: LedgerType.REVERSAL,
          delta: Math.abs(r.points),
          source: "REDEEM_RESTORE",
          sourceId: r.id,
          description: `Restored ${r.points} point(s) for ${reason.toLowerCase()} redemption.`,
        },
      });

      await tx.customerPointsBalance.upsert({
        where: { shop_customerId: { shop, customerId: r.customerId } },
        create: {
          shop,
          customerId: r.customerId,
          balance: Math.abs(r.points),
          lifetimeEarned: 0,
          lifetimeRedeemed: 0,
          lastActivityAt: now,
        },
        update: {
          balance: { increment: Math.abs(r.points) },
          lifetimeRedeemed: { decrement: Math.abs(r.points) },
          lastActivityAt: now,
        },
      });

      await tx.redemption.update({
        where: { id: r.id },
        data: { restoredAt: now, restoreReason: reason },
      });

      restoredCount += 1;
    });
  }

  return { scannedCount: toExpire.length + other.length, expiredCount, restoredCount };
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
