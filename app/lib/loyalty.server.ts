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
