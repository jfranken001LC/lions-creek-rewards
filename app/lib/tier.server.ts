import db from "../db.server";
import type { ShopSettingsNormalized, TierDefinitionNormalized } from "./shopSettings.server";

export type TierProgress = {
  currentTier: TierDefinitionNormalized;
  nextTier: TierDefinitionNormalized | null;
  currentMetric: number;
  remainingToNext: number;
};

export function sortTiers(tiers: TierDefinitionNormalized[]): TierDefinitionNormalized[] {
  return [...tiers].sort((a, b) => {
    if (a.thresholdValue !== b.thresholdValue) return a.thresholdValue - b.thresholdValue;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name);
  });
}

export function resolveTierForMetric(
  settings: ShopSettingsNormalized,
  metricValue: number,
): TierDefinitionNormalized {
  const tiers = sortTiers(settings.tiers);
  let current = tiers[0];
  for (const tier of tiers) {
    if (metricValue >= tier.thresholdValue) current = tier;
  }
  return current;
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
  metricValue: number,
): TierProgress {
  const tiers = sortTiers(settings.tiers);
  const currentTier = resolveTierForMetric(settings, metricValue);
  const currentIdx = tiers.findIndex((t) => t.tierId === currentTier.tierId);
  const nextTier = currentIdx >= 0 && currentIdx < tiers.length - 1 ? tiers[currentIdx + 1] : null;

  return {
    currentTier,
    nextTier,
    currentMetric: metricValue,
    remainingToNext: nextTier ? Math.max(0, nextTier.thresholdValue - metricValue) : 0,
  };
}

export async function refreshCustomerTierSnapshot(
  shop: string,
  customerId: string,
  tx?: any,
): Promise<{ currentTierId: string; currentTierName: string; tierComputedAt: Date }> {
  const client: any = tx ?? db;
  const balance = await client.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
    select: { lifetimeEarned: true },
  });

  const settingsModule = await import("./shopSettings.server");
  const settings = await settingsModule.getOrCreateShopSettings(shop);
  const progress = buildTierProgress(settings, Number(balance?.lifetimeEarned ?? 0));
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
