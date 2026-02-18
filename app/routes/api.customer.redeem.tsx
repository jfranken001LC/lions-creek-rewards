// app/routes/api.customer.redeem.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { shopify } from "../shopify.server";
import { getShopSettings } from "../lib/shopSettings.server";
import { issueRedemptionCode } from "../lib/redemption.server";
import { normalizeCustomerId, shopFromDest, validateRedeemPoints } from "../lib/loyalty.server";
import db from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { cors } = await shopify.authenticate.public.customerAccount(request, {
    corsHeaders: ["Authorization", "Content-Type"],
  });

  // Preflight support (Shopify will OPTIONS before POST)
  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

  // If someone GETs it, keep it tidy.
  return cors(
    Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405, headers: { "Cache-Control": "no-store" } },
    ),
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const { sessionToken, cors } = await shopify.authenticate.public.customerAccount(request, {
    corsHeaders: ["Authorization", "Content-Type"],
  });

  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  if (request.method !== "POST") {
    return cors(
      Response.json(
        { ok: false, error: "method_not_allowed" },
        { status: 405, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }

  const shop = shopFromDest((sessionToken as any).dest);
  const customerId = normalizeCustomerId((sessionToken as any).sub);

  if (!shop) {
    return cors(
      Response.json({ ok: false, error: "invalid_shop" }, { status: 400, headers: { "Cache-Control": "no-store" } }),
    );
  }
  if (!customerId) {
    return cors(
      Response.json(
        { ok: false, error: "customer_not_logged_in" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return cors(
      Response.json({ ok: false, error: "invalid_json" }, { status: 400, headers: { "Cache-Control": "no-store" } }),
    );
  }

  const settings = await getShopSettings(shop);
  const valid = validateRedeemPoints(body?.points, settings.redemptionSteps);
  if (!valid.ok) {
    return cors(
      Response.json({ ok: false, error: valid.error }, { status: 400, headers: { "Cache-Control": "no-store" } }),
    );
  }

  // Ensure we have a balance row and enough points
  const balance = await db.customerPointsBalance.upsert({
    where: { shop_customerId: { shop, customerId } },
    create: { shop, customerId, balance: 0, lifetimeEarned: 0, lifetimeRedeemed: 0, lastActivityAt: new Date() },
    update: {},
  });

  if (balance.balance < valid.points) {
    return cors(
      Response.json(
        { ok: false, error: "insufficient_points", have: balance.balance, need: valid.points },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }

  // Create an Admin client using stored offline session access token
  const { admin } = await shopify.unauthenticated.admin(shop);

  const issued = await issueRedemptionCode({
    admin,
    shop,
    customerId,
    pointsRequested: valid.points,
    eligibleCollectionGid: settings.eligibleCollectionGid,
    eligibleCollectionHandle: settings.eligibleCollectionHandle,
    includeProductTags: settings.includeProductTags,
    excludeProductTags: settings.excludeProductTags,
    excludedCustomerTags: settings.excludedCustomerTags,
    minOrderSubtotalCents: settings.redemptionMinOrderCents,
    redemptionExpiryHours: settings.redemptionExpiryHours,
    redemptionValueMap: settings.redemptionValueMap,
  });

  return cors(
    Response.json({ ok: true, redemption: issued }, { headers: { "Cache-Control": "no-store" } }),
  );
}
