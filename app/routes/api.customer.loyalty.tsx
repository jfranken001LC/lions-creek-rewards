import { json, LoaderFunctionArgs, ActionFunctionArgs } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getShopSettings, V1_REDEMPTION_STEPS, V1_REDEMPTION_VALUE_MAP } from "../lib/shopSettings.server";

function normalizeShopFromDest(dest: string): string {
  return String(dest || "").replace(/^https?:\/\//i, "").trim();
}

function customerIdFromSub(sub: string): string {
  const s = String(sub || "");
  const m = s.match(/Customer\/(\d+)$/);
  if (m) return m[1];
  return s; // fallback
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Handles preflight (OPTIONS) automatically via authenticate helper
  await authenticate.public.customerAccount(request);
  return new Response(null, { status: 204 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken } = await authenticate.public.customerAccount(request);

  const shop = normalizeShopFromDest(sessionToken.dest);
  const customerId = customerIdFromSub(sessionToken.sub);

  const settings = await getShopSettings(shop);

  const balance = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });

  const ledger = await db.pointsLedger.findMany({
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

  const redemptionActive = await db.redemption.findFirst({
    where: {
      shop,
      customerId,
      status: { in: ["ISSUED", "APPLIED"] },
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      code: true,
      valueCents: true,
      minimumSubtotalCents: true,
      status: true,
      expiresAt: true,
      issuedAt: true,
      appliedAt: true,
      voidedAt: true,
    },
  });

  const resp = json({
    ok: true,
    shop,
    customerId,
    pointsBalance: balance?.pointsBalance ?? 0,
    pointsLifetimeEarned: balance?.pointsLifetimeEarned ?? 0,
    pointsLifetimeRedeemed: balance?.pointsLifetimeRedeemed ?? 0,
    pointsLastActivityAt: balance?.pointsLastActivityAt ? balance.pointsLastActivityAt.toISOString() : null,
    ledger: ledger.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    redemptionActive: redemptionActive
      ? {
          ...redemptionActive,
          expiresAt: redemptionActive.expiresAt.toISOString(),
          issuedAt: redemptionActive.issuedAt ? redemptionActive.issuedAt.toISOString() : null,
          appliedAt: redemptionActive.appliedAt ? redemptionActive.appliedAt.toISOString() : null,
          voidedAt: redemptionActive.voidedAt ? redemptionActive.voidedAt.toISOString() : null,
        }
      : null,
    catalog: V1_REDEMPTION_STEPS.map((p) => ({
      points: p,
      valueDollars: V1_REDEMPTION_VALUE_MAP[String(p)],
      minimumOrderDollars: settings.redemptionMinOrder,
    })),
    copy: {
      earn: `Earn ${settings.earnRate} point(s) per $1 of eligible merchandise (net of discounts; excludes taxes/shipping).`,
      expiry: `Points expire after your shop’s configured policy. Unused points may be removed automatically.`,
    },
  });

  return cors(resp);
};
