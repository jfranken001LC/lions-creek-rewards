import db from "../db.server";
import { getShopSettings } from "./shopSettings.server";
import { RedemptionStatus } from "@prisma/client";

export type LoyaltySettingsPublic = {
  earnRate: number;
  redemptionSteps: number[];
  redemptionValueMap: Record<string, number>;
  redemptionMinOrder: number;
};

export type ActiveRedemptionPublic = {
  code: string;
  points: number;
  value: number; // dollars
  expiresAt: string;
};

export type RecentLedgerEntryPublic = {
  createdAt: string;
  type: string;
  delta: number;
  description: string;
  source?: string | null;
  sourceId?: string | null;
};

export type CustomerBalancesPublic = {
  balance: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  lastActivityAt: string | null;
  expiredAt: string | null;
};

export type CustomerLoyaltyResponse = {
  shop: string;
  customerId: string;
  balances: CustomerBalancesPublic;
  settings: LoyaltySettingsPublic;
  activeRedemption: ActiveRedemptionPublic | null;
  recentLedger: RecentLedgerEntryPublic[];
};

function toIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export async function computeCustomerLoyalty(args: {
  shop: string;
  customerId: string;
  now?: Date;
}): Promise<CustomerLoyaltyResponse> {
  const { shop, customerId } = args;
  const now = args.now ?? new Date();

  const [settings, balanceRow, activeRedemptionRow, ledgerRows] = await Promise.all([
    getShopSettings(shop),
    db.customerPointsBalance.findUnique({ where: { shop_customerId: { shop, customerId } } }).catch(() => null),
    db.redemption
      .findFirst({
        where: {
          shop,
          customerId,
          status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
          expiresAt: { gt: now },
          consumedAt: null,
          voidedAt: null,
          expiredAt: null,
          cancelledAt: null,
        },
        orderBy: { createdAt: "desc" },
        select: { code: true, points: true, value: true, expiresAt: true },
      })
      .catch(() => null),
    db.pointsLedger
      .findMany({
        where: { shop, customerId },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          createdAt: true,
          type: true,
          delta: true,
          description: true,
          source: true,
          sourceId: true,
        },
      })
      .catch(() => []),
  ]);

  const balances: CustomerBalancesPublic = {
    balance: balanceRow?.balance ?? 0,
    lifetimeEarned: balanceRow?.lifetimeEarned ?? 0,
    lifetimeRedeemed: balanceRow?.lifetimeRedeemed ?? 0,
    lastActivityAt: toIso(balanceRow?.lastActivityAt),
    expiredAt: toIso(balanceRow?.expiredAt),
  };

  const settingsPublic: LoyaltySettingsPublic = {
    earnRate: settings.earnRate,
    redemptionSteps: settings.redemptionSteps,
    redemptionValueMap: settings.redemptionValueMap,
    redemptionMinOrder: settings.redemptionMinOrder,
  };

  const activeRedemption: ActiveRedemptionPublic | null = activeRedemptionRow
    ? {
        code: activeRedemptionRow.code,
        points: activeRedemptionRow.points,
        value: activeRedemptionRow.value,
        expiresAt: activeRedemptionRow.expiresAt.toISOString(),
      }
    : null;

  const recentLedger: RecentLedgerEntryPublic[] = (ledgerRows ?? []).map((r: any) => ({
    createdAt: new Date(r.createdAt).toISOString(),
    type: String(r.type),
    delta: Number(r.delta ?? 0),
    description: String(r.description ?? ""),
    source: r.source ?? null,
    sourceId: r.sourceId ?? null,
  }));

  return {
    shop,
    customerId,
    balances,
    settings: settingsPublic,
    activeRedemption,
    recentLedger,
  };
}
