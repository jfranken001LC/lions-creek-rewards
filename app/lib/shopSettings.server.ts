import db from "../db.server";

export type TierThresholdType = "lifetimeEarned" | "lifetimeEligibleSpend";

export type TierDefinitionNormalized = {
  id?: string;
  tierId: string;
  name: string;
  sortOrder: number;
  thresholdType: TierThresholdType;
  thresholdValue: number;
  earnRateMultiplier: number;
  pointsPerDollarOverride: number | null;
  effectiveFrom: string | null;
};

export type ShopSettingsNormalized = {
  shop: string;
  earnRate: number;
  baseEarnRate: number;
  redemptionMinOrder: number;
  pointsExpireInactivityDays: number;
  redemptionExpiryHours: number;
  preventMultipleActiveRedemptions: boolean;

  eligibleCollectionHandle: string;
  eligibleCollectionGid: string | null;

  excludedCollectionHandles: string[];
  excludedProductIds: string[];

  excludedCustomerTags: string[];
  includeProductTags: string[];
  excludeProductTags: string[];

  redemptionSteps: number[];
  redemptionValueMap: Record<string, number>;
  tiers: TierDefinitionNormalized[];
};

const DEFAULT_STEPS = [500, 1000];
const DEFAULT_VALUE_MAP: Record<string, number> = { "500": 10, "1000": 25 };

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((x) => String(x)).filter(Boolean);
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return [];
    try {
      return toStringArray(JSON.parse(s));
    } catch {
      return s
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function toNumberArray(value: unknown, fallback: number[]): number[] {
  const raw = toStringArray(value);
  const nums = raw
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0);
  return nums.length ? nums : fallback;
}

function toValueMap(value: unknown, fallback: Record<string, number>): Record<string, number> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) out[String(k)] = n;
    }
    return Object.keys(out).length ? out : fallback;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return fallback;
    try {
      return toValueMap(JSON.parse(s), fallback);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizeThresholdType(raw: unknown): TierThresholdType {
  const value = String(raw ?? "").trim().toLowerCase();
  if (
    value === "lifetimeeligiblespend" ||
    value === "lifetime_eligible_spend" ||
    value === "lifetimeeligiblespenddollars" ||
    value === "eligible_spend" ||
    value === "eligiblespend" ||
    value === "lifetimespend" ||
    value === "spend"
  ) {
    return "lifetimeEligibleSpend";
  }
  return "lifetimeEarned";
}

function normalizeTier(input: any, idx: number, defaultEarnRate: number): TierDefinitionNormalized | null {
  if (!input || typeof input !== "object") return null;
  const name = String(input.name ?? "").trim();
  if (!name) return null;

  const thresholdType = normalizeThresholdType(input.thresholdType);
  const thresholdValue = Math.max(0, Math.floor(Number(input.thresholdValue ?? 0)));
  const sortOrder = Number.isFinite(Number(input.sortOrder)) ? Math.floor(Number(input.sortOrder)) : idx;
  const tierId =
    String(input.tierId ?? "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase() || `tier-${idx + 1}`;

  const multiplier =
    input.pointsPerDollarOverride != null && input.pointsPerDollarOverride !== ""
      ? 1
      : Number.isFinite(Number(input.earnRateMultiplier))
        ? Number(input.earnRateMultiplier)
        : 1;

  const override =
    input.pointsPerDollarOverride != null && input.pointsPerDollarOverride !== ""
      ? Math.max(1, Math.floor(Number(input.pointsPerDollarOverride)))
      : null;

  return {
    id: input.id ? String(input.id) : undefined,
    tierId,
    name,
    sortOrder,
    thresholdType,
    thresholdValue,
    earnRateMultiplier: override != null ? 1 : Math.max(0.01, multiplier || 1),
    pointsPerDollarOverride: override,
    effectiveFrom: input.effectiveFrom ? String(input.effectiveFrom) : null,
  };
}

function defaultTiers(baseEarnRate: number, thresholdType: TierThresholdType = "lifetimeEarned"): TierDefinitionNormalized[] {
  return [
    {
      tierId: "member",
      name: "Member",
      sortOrder: 0,
      thresholdType,
      thresholdValue: 0,
      earnRateMultiplier: 1,
      pointsPerDollarOverride: Math.max(1, Math.floor(Number(baseEarnRate || 1))),
      effectiveFrom: null,
    },
  ];
}

function normalizeTierList(raw: unknown, baseEarnRate: number): TierDefinitionNormalized[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out = arr
    .map((item, idx) => normalizeTier(item, idx, baseEarnRate))
    .filter((x): x is TierDefinitionNormalized => Boolean(x));

  if (!out.length) return defaultTiers(baseEarnRate);

  const sorted = out.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (a.thresholdValue !== b.thresholdValue) return a.thresholdValue - b.thresholdValue;
    return a.name.localeCompare(b.name);
  });

  if (sorted[0].thresholdValue !== 0) {
    sorted.unshift({
      tierId: "member",
      name: "Member",
      sortOrder: -1,
      thresholdType: sorted[0]?.thresholdType ?? "lifetimeEarned",
      thresholdValue: 0,
      earnRateMultiplier: 1,
      pointsPerDollarOverride: Math.max(1, Math.floor(Number(baseEarnRate || 1))),
      effectiveFrom: null,
    });
  }

  return sorted.map((tier, idx) => ({ ...tier, sortOrder: idx }));
}

async function loadTierDefinitions(shop: string, baseEarnRate: number): Promise<TierDefinitionNormalized[]> {
  const prismaAny: any = db as any;
  if (!prismaAny.tierDefinition) return defaultTiers(baseEarnRate);

  const rows = await prismaAny.tierDefinition.findMany({
    where: { shop },
    orderBy: [{ sortOrder: "asc" }, { thresholdValue: "asc" }, { name: "asc" }],
  });

  return normalizeTierList(rows, baseEarnRate);
}

export function normalizeShopSettings(row: any, shop: string, tiers?: TierDefinitionNormalized[]): ShopSettingsNormalized {
  const redemptionSteps = toNumberArray(row?.redemptionSteps, DEFAULT_STEPS);
  const redemptionValueMap = toValueMap(row?.redemptionValueMap, { ...DEFAULT_VALUE_MAP });

  for (const step of redemptionSteps) {
    const key = String(step);
    if (redemptionValueMap[key] == null) {
      redemptionValueMap[key] = Math.round((step / 500) * 10);
    }
  }

  const baseEarnRate = Number.isFinite(row?.earnRate) ? Number(row.earnRate) : 1;

  return {
    shop,
    earnRate: baseEarnRate,
    baseEarnRate,
    redemptionMinOrder: Number.isFinite(row?.redemptionMinOrder) ? Number(row.redemptionMinOrder) : 0,
    pointsExpireInactivityDays: Number.isFinite(row?.pointsExpireInactivityDays)
      ? Number(row.pointsExpireInactivityDays)
      : 365,
    redemptionExpiryHours: Number.isFinite(row?.redemptionExpiryHours)
      ? Number(row.redemptionExpiryHours)
      : 72,
    preventMultipleActiveRedemptions:
      typeof row?.preventMultipleActiveRedemptions === "boolean" ? row.preventMultipleActiveRedemptions : true,

    eligibleCollectionHandle:
      typeof row?.eligibleCollectionHandle === "string" ? row.eligibleCollectionHandle.trim() : "",
    eligibleCollectionGid:
      typeof row?.eligibleCollectionGid === "string" && row.eligibleCollectionGid.trim()
        ? row.eligibleCollectionGid.trim()
        : null,

    excludedCollectionHandles: toStringArray(row?.excludedCollectionHandles),
    excludedProductIds: toStringArray(row?.excludedProductIds),

    excludedCustomerTags: toStringArray(row?.excludedCustomerTags),
    includeProductTags: toStringArray(row?.includeProductTags),
    excludeProductTags: toStringArray(row?.excludeProductTags),

    redemptionSteps,
    redemptionValueMap,
    tiers: normalizeTierList(tiers, baseEarnRate),
  };
}

export async function getShopSettings(shop: string): Promise<ShopSettingsNormalized> {
  const row = await db.shopSettings.findUnique({ where: { shop } });
  const baseEarnRate = Number.isFinite((row as any)?.earnRate) ? Number((row as any).earnRate) : 1;
  const tiers = await loadTierDefinitions(shop, baseEarnRate);
  return normalizeShopSettings(row, shop, tiers);
}

export async function getOrCreateShopSettings(shop: string): Promise<ShopSettingsNormalized> {
  const row =
    (await db.shopSettings.findUnique({ where: { shop } })) ??
    (await db.shopSettings.create({ data: { shop } }));
  const tiers = await loadTierDefinitions(shop, Number((row as any)?.earnRate ?? 1));
  return normalizeShopSettings(row, shop, tiers);
}

export async function upsertShopSettings(shop: string, input: Partial<ShopSettingsNormalized>) {
  const data: any = {
    earnRate: input.baseEarnRate ?? input.earnRate,
    redemptionMinOrder: input.redemptionMinOrder,
    pointsExpireInactivityDays: input.pointsExpireInactivityDays,
    redemptionExpiryHours: input.redemptionExpiryHours,
    preventMultipleActiveRedemptions: input.preventMultipleActiveRedemptions,
    eligibleCollectionHandle: input.eligibleCollectionHandle,
    eligibleCollectionGid: input.eligibleCollectionGid,
    excludedCollectionHandles: input.excludedCollectionHandles,
    excludedProductIds: input.excludedProductIds,
    excludedCustomerTags: input.excludedCustomerTags,
    includeProductTags: input.includeProductTags,
    excludeProductTags: input.excludeProductTags,
    redemptionSteps: input.redemptionSteps,
    redemptionValueMap: input.redemptionValueMap,
  };

  for (const k of Object.keys(data)) {
    if (data[k] === undefined) delete data[k];
  }

  const normalizedTiers = input.tiers ? normalizeTierList(input.tiers, Number(data.earnRate ?? 1)) : undefined;
  const prismaAny: any = db as any;

  const row = await db.$transaction(async (tx) => {
    const nextRow = await tx.shopSettings.upsert({
      where: { shop },
      create: { shop, ...data },
      update: data,
    });

    if (normalizedTiers && prismaAny.tierDefinition) {
      const txAny: any = tx as any;
      await txAny.tierDefinition.deleteMany({ where: { shop } });
      await txAny.tierDefinition.createMany({
        data: normalizedTiers.map((tier) => ({
          shop,
          tierId: tier.tierId,
          name: tier.name,
          sortOrder: tier.sortOrder,
          thresholdType: tier.thresholdType,
          thresholdValue: tier.thresholdValue,
          earnRateMultiplier: tier.earnRateMultiplier,
          pointsPerDollarOverride: tier.pointsPerDollarOverride,
          effectiveFrom: tier.effectiveFrom ? new Date(tier.effectiveFrom) : null,
        })),
      });
    }

    return nextRow;
  });

  const tiers = normalizedTiers ?? (await loadTierDefinitions(shop, Number((row as any)?.earnRate ?? 1)));
  return normalizeShopSettings(row, shop, tiers);
}
