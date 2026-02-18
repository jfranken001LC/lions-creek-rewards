import db from "../db.server";
import { getOrCreateShopSettings } from "./shopSettings.server";

export function normalizeCustomerId(sub: string | undefined | null): string {
  if (!sub) return "";
  const m = sub.match(/Customer\/(\d+)$/);
  return m?.[1] ?? sub;
}

export function shopFromDest(dest: string | undefined | null): string {
  if (!dest) return "";
  try {
    return new URL(dest).hostname;
  } catch {
    return dest;
  }
}

// Keep in sync with redemption.server.ts (72h -> 3 days)
const REDEMPTION_EXPIRE_AFTER_DAYS = 3;

function computeDollarPerPoint(settings: { redemptionSteps: number[]; redemptionValueMap: Record<string, number> }): number {
  const steps = (settings.redemptionSteps ?? []).slice().sort((a, b) => a - b);
  const step = steps[0] ?? 500;
  const value = settings.redemptionValueMap?.[String(step)] ?? 10;
  const dpp = value / step;
  return Number.isFinite(dpp) ? Number(dpp.toFixed(4)) : 0.02;
}

async function getOrCreateBalance(shop: string, customerId: string) {
  return db.customerPointsBalance.upsert({
    where: { shop_customerId: { shop, customerId } },
    create: {
      shop,
      customerId,
      balance: 0,
      lifetimeEarned: 0,
      lifetimeRedeemed: 0,
      lastActivityAt: new Date(),
    },
    update: {},
  });
}

async function getActiveRedemption(shop: string, customerId: string) {
  const row = await db.redemption.findFirst({
    where: { shop, customerId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      code: true,
      pointsDebited: true,
      value: true,
      createdAt: true,
      expiresAt: true,
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    code: row.code,
    pointsDebited: row.pointsDebited,
    valueDollars: row.value,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

async function getRecentLedger(shop: string, customerId: string, take = 25) {
  return db.pointsLedger.findMany({
    where: { shop, customerId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      delta: true,
      type: true,
      source: true,
      sourceId: true,
      description: true,
      createdAt: true,
    },
  });
}

/** Canonical payload for Customer Account UI extension + App Proxy JSON. */
export async function getCustomerLoyaltyPayload(args: { shop: string; customerId: string }) {
  const { shop, customerId } = args;

  const settings = await getOrCreateShopSettings(shop);
  const dollarPerPoint = computeDollarPerPoint(settings);

  const balances = await getOrCreateBalance(shop, customerId);
  const activeRedemption = await getActiveRedemption(shop, customerId);
  const recentLedger = await getRecentLedger(shop, customerId, 25);

  return {
    shop,
    customerId,
    balances,
    // legacy alias
    balance: balances,
    settings: {
      redemptionSteps: settings.redemptionSteps,
      dollarPerPoint,
      expireAfterDays: REDEMPTION_EXPIRE_AFTER_DAYS,
      redemptionMinOrder: settings.redemptionMinOrder,
      earnRate: settings.earnRate,
    },
    activeRedemption,
    recentLedger,
  };
}

/** Backwards-compatible name used by /loyalty and /loyalty.json. */
export async function computeCustomerLoyalty(args: { shop: string; customerId: string }) {
  return getCustomerLoyaltyPayload(args);
}

/** Validate points against allowed step increments. */
export function validateRedeemPoints(points: unknown, allowedSteps: number[]) {
  const n = typeof points === "number" ? points : Number(points);
  if (!Number.isFinite(n) || n <= 0) return { ok: false as const, code: "INVALID_POINTS" as const };

  const steps = (allowedSteps ?? []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  if (steps.length === 0) return { ok: false as const, code: "NO_REDEMPTION_STEPS" as const };

  if (!steps.includes(n)) return { ok: false as const, code: "STEP_NOT_ALLOWED" as const };

  return { ok: true as const, points: n };
}
