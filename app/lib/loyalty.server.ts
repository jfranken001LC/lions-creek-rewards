// app/lib/loyalty.server.ts
import db from "../db.server";
import { LedgerType, RedemptionStatus } from "@prisma/client";
import { getShopSettings } from "./shopSettings.server";

export function normalizeCustomerId(rawSub: unknown): string | null {
  if (!rawSub) return null;
  const sub = String(rawSub);

  // Accept numeric ids as-is
  if (/^\d+$/.test(sub)) return sub;

  // GID form: gid://shopify/Customer/123456789
  const m = sub.match(/Customer\/(\d+)$/);
  if (m?.[1]) return m[1];

  // Fallback: last digits in string
  const lastDigits = sub.match(/(\d+)\D*$/);
  return lastDigits?.[1] ?? null;
}

export function shopFromDest(dest: unknown): string | null {
  if (!dest) return null;
  const d = String(dest);
  try {
    // usually "https://shop.myshopify.com"
    if (d.startsWith("http://") || d.startsWith("https://")) return new URL(d).hostname;
    // sometimes already hostname
    return d;
  } catch {
    return null;
  }
}

export async function getOrCreateCustomerBalance(shop: string, customerId: string) {
  const existing = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });
  if (existing) return existing;

  return db.customerPointsBalance.create({
    data: {
      shop,
      customerId,
      balance: 0,
      lifetimeEarned: 0,
      lifetimeRedeemed: 0,
      lastActivityAt: new Date(),
    },
  });
}

export async function getActiveRedemption(shop: string, customerId: string) {
  const now = new Date();
  return db.redemption.findFirst({
    where: {
      shop,
      customerId,
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      voidedAt: null,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      code: true,
      points: true,
      valueCents: true,
      status: true,
      createdAt: true,
      expiresAt: true,
    },
  });
}

export async function getRecentLedger(shop: string, customerId: string, take = 25) {
  const rows = await db.pointsLedger.findMany({
    where: { shop, customerId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      type: true,
      delta: true,
      description: true,
      createdAt: true,
      source: true,
      sourceId: true,
    },
  });

  // Keep payload minimal + safe for customer surface
  return rows.map((r) => ({
    id: r.id,
    type: r.type as LedgerType,
    delta: r.delta,
    description: r.description,
    createdAt: r.createdAt.toISOString(),
    source: r.source,
    sourceId: r.sourceId,
  }));
}

export async function getCustomerLoyaltyPayload(args: { shop: string; customerId: string }) {
  const { shop, customerId } = args;

  const [settings, balanceRow, activeRedemption, recentLedger] = await Promise.all([
    getShopSettings(shop),
    getOrCreateCustomerBalance(shop, customerId),
    getActiveRedemption(shop, customerId),
    getRecentLedger(shop, customerId, 25),
  ]);

  return {
    shop,
    customerId,
    balance: {
      balance: balanceRow.balance,
      lifetimeEarned: balanceRow.lifetimeEarned,
      lifetimeRedeemed: balanceRow.lifetimeRedeemed,
      lastActivityAt: balanceRow.lastActivityAt?.toISOString() ?? null,
      expiredAt: balanceRow.expiredAt?.toISOString() ?? null,
    },
    settings: {
      pointsPerDollar: settings.pointsPerDollar,
      redemptionSteps: settings.redemptionSteps,
      redemptionValueMap: settings.redemptionValueMap,
      redemptionMinOrderCents: settings.redemptionMinOrderCents,
      eligibleCollectionHandle: settings.eligibleCollectionHandle,
      pointsExpireInactivityDays: settings.pointsExpireInactivityDays,
      redemptionExpiryHours: settings.redemptionExpiryHours,
    },
    activeRedemption: activeRedemption
      ? {
          ...activeRedemption,
          createdAt: activeRedemption.createdAt.toISOString(),
          expiresAt: activeRedemption.expiresAt.toISOString(),
        }
      : null,
    recentLedger,
  };
}

export function validateRedeemPoints(points: unknown, allowedSteps: number[]) {
  if (typeof points !== "number" || !Number.isFinite(points)) {
    return { ok: false as const, error: "invalid_points" };
  }
  const p = Math.trunc(points);
  if (p <= 0) return { ok: false as const, error: "invalid_points" };
  if (!allowedSteps.includes(p)) return { ok: false as const, error: "points_not_allowed_step" };
  return { ok: true as const, points: p };
}
