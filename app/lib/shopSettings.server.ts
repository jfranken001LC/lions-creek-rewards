import db from "../db.server";

export type ShopSettingsNormalized = {
  shop: string;
  earnRate: number; // points per $ (default 1)
  redemptionMinOrder: number; // dollars (default 100)
  eligibleCollections: string[];
  excludedProductIds: string[];
  redemptionSteps: number[]; // e.g. [500, 1000]
  redemptionValueMap: Record<string, number>; // points -> dollars
};

function safeParseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // ignore
    }
  }
  return [];
}

function safeParseValueMap(value: unknown): Record<string, number> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) out[String(k)] = n;
    }
    return out;
  }
  if (typeof value === "string") {
    try {
      return safeParseValueMap(JSON.parse(value));
    } catch {
      // ignore
    }
  }
  return {};
}

export function normalizeShopSettings(row: any, shop: string): ShopSettingsNormalized {
  const redemptionSteps = Array.isArray(row?.redemptionSteps)
    ? row.redemptionSteps.map(Number).filter(Number.isFinite)
    : [500, 1000];

  const redemptionValueMap = safeParseValueMap(row?.redemptionValueMap);

  // Ensure a value exists for each step; default $10 per 500 points.
  for (const step of redemptionSteps) {
    const key = String(step);
    if (redemptionValueMap[key] == null) {
      redemptionValueMap[key] = Math.round((step / 500) * 10);
    }
  }

  return {
    shop,
    earnRate: Number.isFinite(row?.earnRate) ? Number(row.earnRate) : 1,
    redemptionMinOrder: Number.isFinite(row?.redemptionMinOrder) ? Number(row.redemptionMinOrder) : 100,
    eligibleCollections: safeParseJsonArray(row?.eligibleCollections),
    excludedProductIds: safeParseJsonArray(row?.excludedProductIds),
    redemptionSteps,
    redemptionValueMap,
  };
}

export async function getShopSettings(shop: string): Promise<ShopSettingsNormalized> {
  const row = await db.shopSettings.findUnique({ where: { shop } });
  return normalizeShopSettings(row, shop);
}

/** Create row if missing (useful when downstream assumes settings exist). */
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
    eligibleCollections: input.eligibleCollections,
    excludedProductIds: input.excludedProductIds,
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
