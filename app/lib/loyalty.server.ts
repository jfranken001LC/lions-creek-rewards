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


export type CustomerLoyaltyPayload = {
  shop: string;
  customerId: string;
  points: {
    balance: number;
    lifetimeEarned: number;
    lifetimeRedeemed: number;
    lastActivityAt: string | null;
    expireAfterDays: number | null;
  };
  redemption:
    | {
        id: string;
        code: string;
        pointsRedeemed: number;
        discountAmount: number;
        status: "ISSUED" | "APPLIED" | "EXPIRED" | "CANCELED";
        expiresAt: string;
        createdAt: string;
      }
    | null;
  settings: {
    earnRate: number;
    minOrderDollars: number;
    redemptionExpiryHours: number;
    redemptionSteps: number[];
    redemptionValueMap: Record<string, number>;
  };
};

function normalizeRedemptionStatus(
  status: RedemptionStatus | string,
): "ISSUED" | "APPLIED" | "EXPIRED" | "CANCELED" {
  switch (status) {
    case RedemptionStatus.ISSUED:
    case "ISSUED":
      return "ISSUED";
    case RedemptionStatus.APPLIED:
    case "APPLIED":
      return "APPLIED";
    case RedemptionStatus.EXPIRED:
    case "EXPIRED":
      return "EXPIRED";
    case RedemptionStatus.CANCELLED:
    case "CANCELLED":
    case RedemptionStatus.VOID:
    case "VOID":
    case "CANCELED":
      return "CANCELED";
    case RedemptionStatus.CONSUMED:
    case "CONSUMED":
      // The UI contract doesn't expose a distinct "CONSUMED" state; treat as "APPLIED".
      return "APPLIED";
    default:
      return "CANCELED";
  }
}

async function getActiveRedemption(shop: string, customerId: string) {
  const r = await db.redemption.findFirst({
    where: {
      shop,
      customerId,
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      code: true,
      points: true,
      valueDollars: true,
      status: true,
      createdAt: true,
      expiresAt: true,
    },
  });

  if (!r) return null;

  return {
    id: r.id,
    code: r.code,
    pointsRedeemed: r.points,
    discountAmount: r.valueDollars,
    status: normalizeRedemptionStatus(r.status),
    expiresAt: (r.expiresAt ?? r.createdAt).toISOString(),
    createdAt: r.createdAt.toISOString(),
  } as CustomerLoyaltyPayload["redemption"] extends infer T ? Exclude<T, null> : never;
}

export async function getCustomerLoyaltyPayload(shop: string, customerId: string): Promise<CustomerLoyaltyPayload> {
  const settings = await getOrCreateShopSettings(shop);

  const bal = await db.customerPointsBalance.upsert({
    where: { shop_customerId: { shop, customerId } },
    create: { shop, customerId },
    update: {},
  });

  const activeRedemption = await getActiveRedemption(shop, customerId);

  return {
    shop,
    customerId,
    points: {
      balance: bal.balance,
      lifetimeEarned: bal.lifetimeEarned,
      lifetimeRedeemed: bal.lifetimeRedeemed,
      lastActivityAt: bal.lastActivityAt ? bal.lastActivityAt.toISOString() : null,
      expireAfterDays: settings.pointsExpireInactivityDays ?? null,
    },
    redemption: activeRedemption,
    settings: {
      earnRate: settings.earnRate,
      minOrderDollars: settings.redemptionMinOrder,
      redemptionExpiryHours: settings.redemptionExpiryHours,
      redemptionSteps: settings.redemptionSteps,
      redemptionValueMap: settings.redemptionValueMap,
    },
  };
}

export async function computeCustomerLoyalty(args: { shop: string; customerId: string }) {
  // Alias retained for backwards compatibility.
  return getCustomerLoyaltyPayload(args.shop, args.customerId);
}
