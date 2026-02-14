// app/lib/shopSettings.server.ts
import db from "../db.server";

/**
 * Lions Creek Rewards — Shop Settings (server-only)
 *
 * - Single source of truth for defaults + normalization.
 * - v1.1 redemption catalog is hard-locked to avoid drift.
 */

export const V1_REDEMPTION_STEPS = [500, 1000] as const;
export const V1_REDEMPTION_VALUE_MAP: Record<string, number> = {
  "500": 10,
  "1000": 20,
};

export type ShopSettingsNormalized = {
  shop: string;
  earnRate: number;
  redemptionMinOrder: number; // integer dollars
  eligibleCollectionHandle: string;
  eligibleCollectionGid: string | null;

  excludedCustomerTags: string[];
  includeProductTags: string[];
  excludeProductTags: string[];

  redemptionSteps: number[];
  redemptionValueMap: Record<string, number>;
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
    eligibleCollectionHandle: "loyalty-eligible",
    eligibleCollectionGid: null,

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

    eligibleCollectionHandle: String(row.eligibleCollectionHandle ?? defaults.eligibleCollectionHandle),
    eligibleCollectionGid: row.eligibleCollectionGid ? String(row.eligibleCollectionGid) : null,

    excludedCustomerTags: parseStringList(row.excludedCustomerTags) || defaults.excludedCustomerTags,
    includeProductTags: parseStringList(row.includeProductTags) || defaults.includeProductTags,
    excludeProductTags: parseStringList(row.excludeProductTags) || defaults.excludeProductTags,

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
  eligibleCollectionHandle?: string;

  excludedCustomerTags?: string[];
  includeProductTags?: string[];
  excludeProductTags?: string[];
};

export async function upsertShopSettings(shop: string, input: ShopSettingsUpdateInput): Promise<ShopSettingsNormalized> {
  const handle = String(input.eligibleCollectionHandle ?? "loyalty-eligible").trim();

  const normalized = {
    earnRate: clampInt(input.earnRate ?? 1, 1, 100),
    redemptionMinOrder: clampInt(input.redemptionMinOrder ?? 0, 0, 100000),

    eligibleCollectionHandle: handle || "loyalty-eligible",
    // Clear cached GID if handle changed; it'll be re-resolved on first redemption.
    eligibleCollectionGid: null,

    excludedCustomerTags: uniqTrim(input.excludedCustomerTags ?? ["Wholesale"]),
    includeProductTags: uniqTrim(input.includeProductTags ?? []),
    excludeProductTags: uniqTrim(input.excludeProductTags ?? []),

    redemptionSteps: [...V1_REDEMPTION_STEPS],
    redemptionValueMap: { ...V1_REDEMPTION_VALUE_MAP },
    updatedAt: new Date(),
  };

  const existing = await db.shopSettings.findUnique({ where: { shop } }).catch(() => null);

  const row = await db.shopSettings.upsert({
    where: { shop },
    create: { shop, ...normalized } as any,
    update: {
      ...normalized,
      eligibleCollectionGid:
        existing?.eligibleCollectionHandle?.trim().toLowerCase() === normalized.eligibleCollectionHandle.toLowerCase()
          ? existing?.eligibleCollectionGid ?? null
          : null,
    } as any,
  });

  return normalizeShopSettings(shop, row);
}
