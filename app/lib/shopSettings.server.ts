import db from "../db.server";

/**
 * Lions Creek Rewards — Shop Settings (server-only)
 *
 * Goals:
 * - Single source of truth for defaults + normalization.
 * - Enforce v1 constraints (redemption steps / value map) to avoid config drift.
 */

export const V1_REDEMPTION_STEPS = [500, 1000] as const;
export const V1_REDEMPTION_VALUE_MAP: Record<string, number> = {
  "500": 10,
  "1000": 20,
};

export type ShopSettingsNormalized = {
  shop: string;
  earnRate: number; // points per $1 eligible net merchandise
  redemptionMinOrder: number; // CAD subtotal minimum (integer dollars)
  excludedCustomerTags: string[];
  includeProductTags: string[]; // when non-empty, only these product tags earn/redeem
  excludeProductTags: string[]; // always excluded
  redemptionSteps: number[]; // v1 fixed [500,1000]
  redemptionValueMap: Record<string, number>; // v1 fixed {500:10,1000:20}
  updatedAt?: Date;
};

function uniqTrim(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const v = String(raw ?? "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function parseStringList(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return uniqTrim(value.map((v) => String(v)));
  if (typeof value === "string") {
    // Accept JSON array or CSV
    const s = value.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return uniqTrim(parsed.map((v) => String(v)));
    } catch {
      // ignore
    }
    return uniqTrim(
      s
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    );
  }
  return [];
}

function clampInt(n: any, min: number, max: number): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

export function normalizeShopSettings(shop: string, row: any | null): ShopSettingsNormalized {
  const defaults: ShopSettingsNormalized = {
    shop,
    earnRate: 1,
    redemptionMinOrder: 0,
    excludedCustomerTags: ["Wholesale"],
    includeProductTags: [],
    excludeProductTags: [],
    redemptionSteps: [...V1_REDEMPTION_STEPS],
    redemptionValueMap: { ...V1_REDEMPTION_VALUE_MAP },
    updatedAt: row?.updatedAt ? new Date(row.updatedAt) : undefined,
  };

  if (!row) return defaults;

  return {
    ...defaults,
    earnRate: clampInt(row.earnRate ?? defaults.earnRate, 1, 100),
    redemptionMinOrder: clampInt(row.redemptionMinOrder ?? defaults.redemptionMinOrder, 0, 100000),
    excludedCustomerTags: parseStringList(row.excludedCustomerTags) || defaults.excludedCustomerTags,
    includeProductTags: parseStringList(row.includeProductTags) || defaults.includeProductTags,
    excludeProductTags: parseStringList(row.excludeProductTags) || defaults.excludeProductTags,

    // v1 hard lock
    redemptionSteps: [...V1_REDEMPTION_STEPS],
    redemptionValueMap: { ...V1_REDEMPTION_VALUE_MAP },

    updatedAt: row?.updatedAt ? new Date(row.updatedAt) : defaults.updatedAt,
  };
}

export async function getShopSettings(shop: string): Promise<ShopSettingsNormalized> {
  const row = await db.shopSettings.findUnique({ where: { shop } }).catch(() => null);
  return normalizeShopSettings(shop, row);
}

export type ShopSettingsUpdateInput = {
  earnRate?: number;
  redemptionMinOrder?: number;
  excludedCustomerTags?: string[];
  includeProductTags?: string[];
  excludeProductTags?: string[];
};

export async function upsertShopSettings(shop: string, input: ShopSettingsUpdateInput): Promise<ShopSettingsNormalized> {
  const normalized = {
    earnRate: clampInt(input.earnRate ?? 1, 1, 100),
    redemptionMinOrder: clampInt(input.redemptionMinOrder ?? 0, 0, 100000),
    excludedCustomerTags: uniqTrim(input.excludedCustomerTags ?? ["Wholesale"]),
    includeProductTags: uniqTrim(input.includeProductTags ?? []),
    excludeProductTags: uniqTrim(input.excludeProductTags ?? []),

    // v1 hard lock
    redemptionSteps: [...V1_REDEMPTION_STEPS],
    redemptionValueMap: { ...V1_REDEMPTION_VALUE_MAP },
    updatedAt: new Date(),
  };

  const row = await db.shopSettings.upsert({
    where: { shop },
    create: { shop, ...normalized } as any,
    update: normalized as any,
  });

  return normalizeShopSettings(shop, row);
}
