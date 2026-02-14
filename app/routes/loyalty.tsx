// app/routes/loyalty.tsx
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopSettings } from "../lib/shopSettings.server";
import { issueRedemptionCode, normalizeCustomerId } from "../lib/redemption.server";
import { RedemptionStatus } from "@prisma/client";

type LedgerRow = {
  id: string;
  type: string;
  delta: number;
  description: string;
  createdAt: string;
};

function toInt(n: any, fallback = 0): number {
  const x = Math.floor(Number(n));
  return Number.isFinite(x) ? x : fallback;
}

function dollarsToCents(dollars: number): number {
  return Math.round(Number(dollars || 0) * 100);
}

/**
 * Storefront App Proxy endpoint (optional).
 *
 * GET: returns customer balance + ledger + active redemption
 * POST: issues a redemption code (uses the same canonical service as Customer Accounts)
 *
 * NOTE: This route is kept mainly for backwards compatibility while your primary UI
 * is the Customer Accounts UI extension. It must remain schema-consistent.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, appProxy } = await authenticate.public.appProxy(request);

  const shop = session.shop;

  // App Proxy customer_id is numeric; normalize anyway for safety
  const customerId = appProxy.customerId ? normalizeCustomerId(String(appProxy.customerId)) : null;

  const settings = await getShopSettings(shop);

  if (!customerId) {
    return json({
      ok: true,
      mode: "app_proxy",
      shop,
      customerId: null,
      message: "Not logged in.",
      settings: {
        earnRate: settings.earnRate,
        redemptionMinOrder: settings.redemptionMinOrder,
        eligibleCollectionHandle: settings.eligibleCollectionHandle,
        redemptionSteps: settings.redemptionSteps,
        redemptionValueMap: settings.redemptionValueMap,
        codeExpiryHours: 72,
      },
      balance: null,
      ledger: [],
      redemptionActive: null,
    });
  }

  const balanceRow =
    (await db.customerPointsBalance.findUnique({
      where: { shop_customerId: { shop, customerId } },
    })) ??
    (await db.customerPointsBalance.create({
      data: { shop, customerId, balance: 0, lifetimeEarned: 0, lifetimeRedeemed: 0 },
    }));

  const ledgerRaw = await db.pointsLedger.findMany({
    where: { shop, customerId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      type: true,
      delta: true,
      description: true,
      createdAt: true,
    },
  });

  const ledger: LedgerRow[] = ledgerRaw.map((r) => ({
    id: r.id,
    type: String(r.type),
    delta: r.delta,
    description: r.description ?? "",
    createdAt: r.createdAt.toISOString(),
  }));

  const now = new Date();
  const redemptionActive = await db.redemption.findFirst({
    where: {
      shop,
      customerId,
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { issuedAt: "desc" },
    select: {
      id: true,
      code: true,
      points: true,
      value: true, // dollars (int)
      status: true,
      expiresAt: true,
    },
  });

  return json({
    ok: true,
    mode: "app_proxy",
    shop,
    customerId,
    settings: {
      earnRate: settings.earnRate,
      redemptionMinOrder: settings.redemptionMinOrder,
      eligibleCollectionHandle: settings.eligibleCollectionHandle,
      redemptionSteps: settings.redemptionSteps,
      redemptionValueMap: settings.redemptionValueMap,
      codeExpiryHours: 72,
    },
    balance: {
      pointsBalance: balanceRow.balance,
      pointsLifetimeEarned: balanceRow.lifetimeEarned,
      pointsLifetimeRedeemed: balanceRow.lifetimeRedeemed,
      pointsLastActivityAt: balanceRow.lastActivityAt?.toISOString?.() ?? null,
      expiredAt: balanceRow.expiredAt ? balanceRow.expiredAt.toISOString() : null,
    },
    ledger,
    redemptionActive: redemptionActive
      ? {
          id: redemptionActive.id,
          code: redemptionActive.code,
          points: redemptionActive.points,
          valueDollars: redemptionActive.value,
          valueCents: dollarsToCents(redemptionActive.value),
          minimumSubtotalCents: dollarsToCents(settings.redemptionMinOrder),
          status: redemptionActive.status,
          expiresAt: (redemptionActive.expiresAt ?? now).toISOString(),
        }
      : null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, appProxy } = await authenticate.public.appProxy(request);

  const shop = session.shop;
  const customerId = appProxy.customerId ? normalizeCustomerId(String(appProxy.customerId)) : null;

  if (!customerId) {
    return json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const settings = await getShopSettings(shop);

  // If there is already an active code, return it (single-active-code policy).
  const now = new Date();
  const existingActive = await db.redemption.findFirst({
    where: {
      shop,
      customerId,
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { issuedAt: "desc" },
    select: { id: true, code: true, points: true, value: true, expiresAt: true },
  });

  if (existingActive) {
    return json({
      ok: true,
      alreadyIssued: true,
      redemptionId: existingActive.id,
      code: existingActive.code,
      expiresAt: (existingActive.expiresAt ?? now).toISOString(),
      points: existingActive.points,
      valueDollars: existingActive.value,
      valueCents: dollarsToCents(existingActive.value),
      minimumSubtotalCents: dollarsToCents(settings.redemptionMinOrder),
    });
  }

  const form = await request.formData();
  const pointsRequested = toInt(form.get("points"), 0);

  if (!pointsRequested) {
    return json({ ok: false, error: "Missing points." }, { status: 400 });
  }

  try {
    const result = await issueRedemptionCode({
      shop,
      admin: admin as any,
      customerId,
      pointsRequested,
      // optional: allow storefront to send an idempotency key
      idemKey: String(form.get("idemKey") ?? "").trim() || null,
    });

    return json({
      ok: true,
      alreadyIssued: false,
      redemptionId: result.redemptionId,
      code: result.code,
      expiresAt: result.expiresAt,
      points: result.points,
      valueDollars: result.valueDollars,
      valueCents: dollarsToCents(result.valueDollars),
      minimumSubtotalCents: dollarsToCents(settings.redemptionMinOrder),
      discountNodeId: result.discountNodeId,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Redemption failed" }, { status: 400 });
  }
};

export default function LoyaltyRoute() {
  // App proxy routes typically render via Liquid/Storefront. No embedded UI here.
  return null;
}
