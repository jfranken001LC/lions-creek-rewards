import db from "../db.server";

export type ShopSettingsNormalized = {
  shop: string;
  earnRate: number;
  redemptionMinOrder: number;
  pointsExpireInactivityDays: number;
  redemptionExpiryHours: number;
  preventMultipleActiveRedemptions: boolean;

  eligibleCollectionHandle: string;
  eligibleCollectionGid: string | null;

  excludedCustomerTags: string[];
  includeProductTags: string[];
  excludeProductTags: string[];

  redemptionSteps: number[];
  redemptionValueMap: Record<string, number>;
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

export function normalizeShopSettings(row: any, shop: string): ShopSettingsNormalized {
  const redemptionSteps = toNumberArray(row?.redemptionSteps, DEFAULT_STEPS);
  const redemptionValueMap = toValueMap(row?.redemptionValueMap, { ...DEFAULT_VALUE_MAP });

  for (const step of redemptionSteps) {
    const key = String(step);
    if (redemptionValueMap[key] == null) {
      redemptionValueMap[key] = Math.round((step / 500) * 10);
    }
  }

  return {
    shop,
    earnRate: Number.isFinite(row?.earnRate) ? Number(row.earnRate) : 1,
    redemptionMinOrder: Number.isFinite(row?.redemptionMinOrder) ? Number(row.redemptionMinOrder) : 0,
    pointsExpireInactivityDays: Number.isFinite(row?.pointsExpireInactivityDays)
      ? Number(row.pointsExpireInactivityDays)
      : 365,
    redemptionExpiryHours: Number.isFinite(row?.redemptionExpiryHours)
      ? Number(row.redemptionExpiryHours)
      : 72,

    preventMultipleActiveRedemptions: typeof row?.preventMultipleActiveRedemptions === "boolean" ? row.preventMultipleActiveRedemptions : true,

    eligibleCollectionHandle:
      typeof row?.eligibleCollectionHandle === "string" && row.eligibleCollectionHandle.trim()
        ? row.eligibleCollectionHandle.trim()
        : "lcr_loyalty_eligible",
    eligibleCollectionGid:
      typeof row?.eligibleCollectionGid === "string" && row.eligibleCollectionGid.trim()
        ? row.eligibleCollectionGid.trim()
        : null,

    excludedCustomerTags: toStringArray(row?.excludedCustomerTags),
    includeProductTags: toStringArray(row?.includeProductTags),
    excludeProductTags: toStringArray(row?.excludeProductTags),

    redemptionSteps,
    redemptionValueMap,
  };
}

export async function getShopSettings(shop: string): Promise<ShopSettingsNormalized> {
  const row = await db.shopSettings.findUnique({ where: { shop } });
  return normalizeShopSettings(row, shop);
}

export async function getOrCreateShopSettings(shop: string): Promise<ShopSettingsNormalized> {
  const row =
    (await db.shopSettings.findUnique({ where: { shop } })) ??
    (await db.shopSettings.create({ data: { shop } }));
  return normalizeShopSettings(row, shop);
}

export async function upsertShopSettings(shop: string, input: Partial<ShopSettingsNormalized>) {
  const data: any = {
    earnRate: input.earnRate,
    redemptionMinOrder: input.redemptionMinOrder,
    pointsExpireInactivityDays: input.pointsExpireInactivityDays,
    redemptionExpiryHours: input.redemptionExpiryHours,
    preventMultipleActiveRedemptions: input.preventMultipleActiveRedemptions,
    eligibleCollectionHandle: input.eligibleCollectionHandle,
    eligibleCollectionGid: input.eligibleCollectionGid,
    excludedCustomerTags: input.excludedCustomerTags,
    includeProductTags: input.includeProductTags,
    excludeProductTags: input.excludeProductTags,
    redemptionSteps: input.redemptionSteps,
    redemptionValueMap: input.redemptionValueMap,
  };

  for (const k of Object.keys(data)) {
    if (data[k] === undefined) delete data[k];
  }

  const row = await db.shopSettings.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });

  return normalizeShopSettings(row, shop);
}
