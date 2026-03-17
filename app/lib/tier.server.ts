import db from "../db.server";
import type { ShopSettingsNormalized, TierDefinitionNormalized, TierThresholdType } from "./shopSettings.server";

export type TierMetrics = {
  lifetimeEarned: number;
  lifetimeEligibleSpend: number;
  lifetimeEligibleSpendCents: number;
};

export type TierProgress = {
  currentTier: TierDefinitionNormalized;
  nextTier: TierDefinitionNormalized | null;
  currentMetric: number;
  currentMetricType: TierThresholdType;
  remainingToNext: number;
  remainingMetricType: TierThresholdType;
};

export function sortTiers(tiers: TierDefinitionNormalized[]): TierDefinitionNormalized[] {
  return [...tiers].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (a.thresholdValue !== b.thresholdValue) return a.thresholdValue - b.thresholdValue;
    return a.name.localeCompare(b.name);
  });
}

export function metricValueForThresholdType(metrics: TierMetrics, thresholdType: TierThresholdType): number {
  return thresholdType === "lifetimeEligibleSpend"
    ? Number(metrics.lifetimeEligibleSpend ?? 0)
    : Number(metrics.lifetimeEarned ?? 0);
}

export function resolveTierForMetrics(
  settings: ShopSettingsNormalized,
  metrics: TierMetrics,
): TierDefinitionNormalized {
  const tiers = sortTiers(settings.tiers);
  let current = tiers[0];

  for (const tier of tiers) {
    const metricValue = metricValueForThresholdType(metrics, tier.thresholdType);
    if (metricValue >= tier.thresholdValue) current = tier;
  }

  return current;
}

export function resolveTierForMetric(
  settings: ShopSettingsNormalized,
  metricValue: number,
  thresholdType: TierThresholdType = "lifetimeEarned",
): TierDefinitionNormalized {
  const metrics: TierMetrics = {
    lifetimeEarned: thresholdType === "lifetimeEarned" ? Number(metricValue ?? 0) : 0,
    lifetimeEligibleSpend: thresholdType === "lifetimeEligibleSpend" ? Number(metricValue ?? 0) : 0,
    lifetimeEligibleSpendCents: thresholdType === "lifetimeEligibleSpend" ? Math.max(0, Math.round(Number(metricValue ?? 0) * 100)) : 0,
  };
  return resolveTierForMetrics(settings, metrics);
}

export function computeEffectiveEarnRate(
  settings: ShopSettingsNormalized,
  tier: TierDefinitionNormalized,
): number {
  const base = Math.max(1, Number(settings.baseEarnRate || settings.earnRate || 1));
  if (tier.pointsPerDollarOverride != null && Number.isFinite(tier.pointsPerDollarOverride)) {
    return Math.max(1, Math.round(Number(tier.pointsPerDollarOverride)));
  }
  const multiplier = Number.isFinite(tier.earnRateMultiplier) ? tier.earnRateMultiplier : 1;
  return Math.max(1, Math.round(base * multiplier));
}

export function buildTierProgress(
  settings: ShopSettingsNormalized,
  metricsOrValue: TierMetrics | number,
  thresholdType: TierThresholdType = "lifetimeEarned",
): TierProgress {
  const metrics: TierMetrics =
    typeof metricsOrValue === "number"
      ? {
          lifetimeEarned: thresholdType === "lifetimeEarned" ? Number(metricsOrValue ?? 0) : 0,
          lifetimeEligibleSpend: thresholdType === "lifetimeEligibleSpend" ? Number(metricsOrValue ?? 0) : 0,
          lifetimeEligibleSpendCents:
            thresholdType === "lifetimeEligibleSpend"
              ? Math.max(0, Math.round(Number(metricsOrValue ?? 0) * 100))
              : 0,
        }
      : metricsOrValue;

  const tiers = sortTiers(settings.tiers);
  const currentTier = resolveTierForMetrics(settings, metrics);
  const currentIdx = tiers.findIndex((t) => t.tierId === currentTier.tierId);
  const nextTier = currentIdx >= 0 && currentIdx < tiers.length - 1 ? tiers[currentIdx + 1] : null;
  const progressMetricType = nextTier?.thresholdType ?? currentTier.thresholdType;
  const currentMetric = metricValueForThresholdType(metrics, progressMetricType);

  return {
    currentTier,
    nextTier,
    currentMetric,
    currentMetricType: progressMetricType,
    remainingToNext: nextTier ? Math.max(0, nextTier.thresholdValue - currentMetric) : 0,
    remainingMetricType: progressMetricType,
  };
}

export async function getCustomerTierMetrics(shop: string, customerId: string, tx?: any): Promise<TierMetrics> {
  const client: any = tx ?? db;

  const [balance, snapshots] = await Promise.all([
    client.customerPointsBalance.findUnique({
      where: { shop_customerId: { shop, customerId } },
      select: { lifetimeEarned: true },
    }),
    client.orderPointsSnapshot.findMany({
      where: { shop, customerId },
      select: {
        eligibleNetMerchandise: true,
        pointsAwarded: true,
        pointsReversedToDate: true,
        cancelledAt: true,
      },
    }),
  ]);

  let lifetimeEligibleSpendCents = 0;

  for (const row of snapshots ?? []) {
    const eligibleNetMerchandise = Math.max(0, Number((row as any)?.eligibleNetMerchandise ?? 0));
    if (eligibleNetMerchandise <= 0) continue;

    if ((row as any)?.cancelledAt) continue;

    const pointsAwarded = Math.max(0, Number((row as any)?.pointsAwarded ?? 0));
    const pointsReversedToDate = Math.max(0, Number((row as any)?.pointsReversedToDate ?? 0));

    if (pointsAwarded > 0) {
      const remainingRatio = Math.max(0, Math.min(1, (pointsAwarded - pointsReversedToDate) / pointsAwarded));
      lifetimeEligibleSpendCents += Math.round(eligibleNetMerchandise * remainingRatio);
      continue;
    }

    lifetimeEligibleSpendCents += eligibleNetMerchandise;
  }

  return {
    lifetimeEarned: Number(balance?.lifetimeEarned ?? 0),
    lifetimeEligibleSpendCents,
    lifetimeEligibleSpend: Math.floor(lifetimeEligibleSpendCents / 100),
  };
}

export async function refreshCustomerTierSnapshot(
  shop: string,
  customerId: string,
  tx?: any,
): Promise<{ currentTierId: string; currentTierName: string; tierComputedAt: Date }> {
  const client: any = tx ?? db;
  const settingsModule = await import("./shopSettings.server");
  const settings = await settingsModule.getOrCreateShopSettings(shop);
  const metrics = await getCustomerTierMetrics(shop, customerId, client);
  const progress = buildTierProgress(settings, metrics);
  const tierComputedAt = new Date();

  await client.customerPointsBalance.update({
    where: { shop_customerId: { shop, customerId } },
    data: {
      currentTierId: progress.currentTier.tierId,
      currentTierName: progress.currentTier.name,
      tierComputedAt,
    } as any,
  });

  return {
    currentTierId: progress.currentTier.tierId,
    currentTierName: progress.currentTier.name,
    tierComputedAt,
  };
}
