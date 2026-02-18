// app/lib/shopSettings.server.ts
import db from "../db.server";

export type ShopSettingsNormalized = {
  shop: string;

  // canonical internal name
  earnRate: number;

  // API payload alias
  pointsPerDollar: number;

  // used by /jobs/expire and customer payload
  pointsExpireInactivityDays: number;

  // redemption settings
  redemptionMinOrder: number; // integer dollars
  redemptionMinOrderCents: number; // computed convenience
  redemptionExpiryHours: number;

  eligibleCollectionHandle: string;
  eligibleCollectionGid: string | null;

  excludedCustomerTags: string[];
  includeProductTags: string[];
  excludeProductTags: string[];

  redemptionSteps: number[];
  redemptionValueMap: Record<string, number>; // points string -> dollars number
};

export type ShopSettingsUpdateInput = {
  earnRate?: number;
  pointsExpireInactivityDays?: number;
  redemptionExpiryHours?: number;

  redemptionMinOrder?: number;
  eligibleCollectionHandle?: string;

  excludedCustomerTags?: string[];
  includeProductTags?: string[];
  excludeProductTags?: string[];

  redemptionSteps?: number[];
  redemptionValueMap?: Record<string, number>;
};

function clampInt(v: unknown, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function parseStringList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

const V1_REDEMPTION_STEPS = [500, 1000];
const V1_REDEMPTION_VALUE_MAP: Record<string, number> = {
  "500": 10,
  "1000": 25,
};

export function normalizeShopSettings(shop: string, row: any | null): ShopSettingsNormalized {
  const defaults: ShopSettingsNormalized = {
    shop,
    earnRate: 1,
    pointsPerDollar: 1,
    pointsExpireInactivityDays: 365,

    redemptionMinOrder: 0,
    redemptionMinOrderCents: 0,
    redemptionExpiryHours: 72,

    eligibleCollectionHandle: "lcr_loyalty_eligible",
    eligibleCollectionGid: null,

    excludedCustomerTags: ["Wholesale"],
    includeProductTags: [],
    excludeProductTags: [],

    redemptionSteps: V1_REDEMPTION_STEPS,
    redemptionValueMap: V1_REDEMPTION_VALUE_MAP,
  };

  if (!row) return defaults;

  const earnRate = clampInt(row.earnRate ?? defaults.earnRate, 0, 10000);
  const pointsExpireInactivityDays = clampInt(row.pointsExpireInactivityDays ?? defaults.pointsExpireInactivityDays, 0, 10000);
  const redemptionMinOrder = clampInt(row.redemptionMinOrder ?? defaults.redemptionMinOrder, 0, 100000);
  const redemptionExpiryHours = clampInt(row.redemptionExpiryHours ?? defaults.redemptionExpiryHours, 1, 24 * 365);

  const eligibleCollectionHandle = String(row.eligibleCollectionHandle ?? defaults.eligibleCollectionHandle).trim() || defaults.eligibleCollectionHandle;

  const excludedCustomerTagsParsed = parseStringList(row.excludedCustomerTags);
  const includeProductTagsParsed = parseStringList(row.includeProductTags);
  const excludeProductTagsParsed = parseStringList(row.excludeProductTags);

  return {
    ...defaults,
    earnRate,
    pointsPerDollar: earnRate,
    pointsExpireInactivityDays,

    redemptionMinOrder,
    redemptionMinOrderCents: redemptionMinOrder * 100,
    redemptionExpiryHours,

    eligibleCollectionHandle,
    eligibleCollectionGid: typeof row.eligibleCollectionGid === "string" ? row.eligibleCollectionGid : null,

    excludedCustomerTags: excludedCustomerTagsParsed.length ? excludedCustomerTagsParsed : defaults.excludedCustomerTags,
    includeProductTags: includeProductTagsParsed,
    excludeProductTags: excludeProductTagsParsed,

    // v1 hard-lock; allow override if present
    redemptionSteps: Array.isArray(row.redemptionSteps) ? row.redemptionSteps.map((n: any) => clampInt(n, 1, 100000)) : defaults.redemptionSteps,
    redemptionValueMap: (row.redemptionValueMap && typeof row.redemptionValueMap === "object") ? row.redemptionValueMap : defaults.redemptionValueMap,
  };
}

export async function getShopSettings(shop: string): Promise<ShopSettingsNormalized> {
  const row = await db.shopSettings.findUnique({ where: { shop } });
  return normalizeShopSettings(shop, row);
}

export async function upsertShopSettings(shop: string, input: ShopSettingsUpdateInput): Promise<ShopSettingsNormalized> {
  const handle = String(input.eligibleCollectionHandle ?? "lcr_loyalty_eligible").trim();

  const normalized: any = {
    earnRate: clampInt(input.earnRate ?? 1, 0, 10000),
    pointsExpireInactivityDays: clampInt(input.pointsExpireInactivityDays ?? 365, 0, 10000),
    redemptionExpiryHours: clampInt(input.redemptionExpiryHours ?? 72, 1, 24 * 365),

    redemptionMinOrder: clampInt(input.redemptionMinOrder ?? 0, 0, 100000),
    eligibleCollectionHandle: handle || "lcr_loyalty_eligible",

    excludedCustomerTags: input.excludedCustomerTags ?? ["Wholesale"],
    includeProductTags: input.includeProductTags ?? [],
    excludeProductTags: input.excludeProductTags ?? [],

    redemptionSteps: input.redemptionSteps ?? V1_REDEMPTION_STEPS,
    redemptionValueMap: input.redemptionValueMap ?? V1_REDEMPTION_VALUE_MAP,

    // keep unless handle changes
    eligibleCollectionGid: null,
  };

  const existing = await db.shopSettings.findUnique({ where: { shop }, select: { eligibleCollectionGid: true, eligibleCollectionHandle: true } });
  if (existing?.eligibleCollectionHandle === normalized.eligibleCollectionHandle) {
    normalized.eligibleCollectionGid = existing.eligibleCollectionGid;
  }

  await db.shopSettings.upsert({
    where: { shop },
    create: { shop, ...normalized },
    update: normalized,
  });

  return getShopSettings(shop);
}
