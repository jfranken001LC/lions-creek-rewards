import db from "../db.server";
import { RedemptionStatus } from "@prisma/client";
import { getOrCreateShopSettings } from "./shopSettings.server";

export function normalizeCustomerId(raw: string): string {
  if (!raw) return "";
  const s = String(raw).trim();
  const m = s.match(/Customer\/(\d+)/i);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;
  return s;
}

export async function getOrCreateCustomerBalance(shop: string, customerId: string) {
  const cid = normalizeCustomerId(customerId);
  if (!cid) throw new Error("customerId is required");

  return db.customerPointsBalance.upsert({
    where: { shop_customerId: { shop, customerId: cid } },
    create: { shop, customerId: cid },
    update: {},
  });
}

export async function getActiveRedemption(shop: string, customerId: string) {
  const cid = normalizeCustomerId(customerId);
  if (!cid) return null;

  const now = new Date();
  return db.redemption.findFirst({
    where: {
      shop,
      customerId: cid,
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: "desc" },
    select: { code: true, points: true, valueDollars: true, status: true, createdAt: true, expiresAt: true },
  });
}

export async function getCustomerLoyaltyPayload(shop: string, customerId: string) {
  const cid = normalizeCustomerId(customerId);
  if (!cid) throw new Error("customerId is required");

  const [settings, balance, activeRedemption] = await Promise.all([
    getOrCreateShopSettings(shop),
    getOrCreateCustomerBalance(shop, cid),
    getActiveRedemption(shop, cid),
  ]);

  return {
    shop,
    customerId: cid,
    points: {
      balance: balance.balance,
      lifetimeEarned: balance.lifetimeEarned,
      lifetimeRedeemed: balance.lifetimeRedeemed,
      lastActivityAt: balance.lastActivityAt.toISOString(),
      expireAfterDays: settings.pointsExpireInactivityDays,
    },
    redemption: activeRedemption
      ? {
          code: activeRedemption.code,
          pointsDebited: activeRedemption.points,
          valueDollars: activeRedemption.valueDollars,
          status: activeRedemption.status,
          issuedAt: activeRedemption.createdAt.toISOString(),
          expiresAt: activeRedemption.expiresAt ? activeRedemption.expiresAt.toISOString() : null,
        }
      : null,
    settings: {
      earnRate: settings.earnRate,
      minOrderDollars: settings.redemptionMinOrder,
      redemptionExpiryHours: settings.redemptionExpiryHours,
      redemptionSteps: settings.redemptionSteps,
      redemptionValueMap: settings.redemptionValueMap,
    },
  };
}

/**
 * Required by routes/loyalty.json.tsx and routes/loyalty.tsx.
 * This is the canonical computation used by the app proxy endpoints.
 *
 * Shape: returns the same base payload as getCustomerLoyaltyPayload,
 * plus recent ledger activity for debug/admin visibility.
 */
export async function computeCustomerLoyalty(args: { shop: string; customerId?: string | null }) {
  const shop = String(args?.shop || "").trim();
  const cid = normalizeCustomerId(String(args?.customerId || "").trim());

  if (!shop) throw new Error("shop is required");
  if (!cid) throw new Error("customerId is required");

  const base = await getCustomerLoyaltyPayload(shop, cid);

  const recentLedger = await db.pointsLedger.findMany({
    where: { shop, customerId: cid },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      type: true,
      delta: true,
      source: true,
      sourceId: true,
      description: true,
      createdAt: true,
    },
  });

  return {
    ...base,
    activity: {
      recentLedger: recentLedger.map((x) => ({
        type: x.type,
        delta: x.delta,
        source: x.source,
        sourceId: x.sourceId,
        description: x.description ?? null,
        createdAt: x.createdAt.toISOString(),
      })),
    },
  };
}
