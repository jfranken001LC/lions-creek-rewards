import { json, type LoaderFunctionArgs } from "react-router";
import crypto from "crypto";
import db from "../db.server";
import { getShopSettings } from "../lib/shopSettings.server";

/**
 * Storefront App Proxy JSON endpoint.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const shop = params.shop;

  if (!shop) return json({ ok: false, error: "Missing shop" }, { status: 400 });
  if (!verifyProxySignature(params)) return json({ ok: false, error: "Invalid signature" }, { status: 401 });

  const customerId = params.customer_id ? String(params.customer_id) : null;
  const settings = await getShopSettings(shop);

  if (!customerId) {
    return json({
      ok: true,
      shop,
      customerId: null,
      pointsBalance: 0,
      pointsLifetimeEarned: 0,
      pointsLifetimeRedeemed: 0,
      pointsLastActivityAt: null,
      expiredAt: null,
      settings: { earnRate: settings.earnRate, redemptionMinOrder: settings.redemptionMinOrder, redemptionSteps: settings.redemptionSteps, codeExpiryHours: 72 },
    });
  }

  const balanceRow =
    (await db.customerPointsBalance.findUnique({ where: { shop_customerId: { shop, customerId } } })) ??
    (await db.customerPointsBalance.create({ data: { shop, customerId, balance: 0, lifetimeEarned: 0, lifetimeRedeemed: 0 } }));

  return json({
    ok: true,
    shop,
    customerId,
    pointsBalance: balanceRow.balance,
    pointsLifetimeEarned: balanceRow.lifetimeEarned,
    pointsLifetimeRedeemed: balanceRow.lifetimeRedeemed,
    pointsLastActivityAt: balanceRow.lastActivityAt.toISOString(),
    expiredAt: balanceRow.expiredAt ? balanceRow.expiredAt.toISOString() : null,
    settings: { earnRate: settings.earnRate, redemptionMinOrder: settings.redemptionMinOrder, redemptionSteps: settings.redemptionSteps, codeExpiryHours: 72 },
  });
};

function verifyProxySignature(params: Record<string, string>): boolean {
  const provided = params.signature ?? "";
  if (!provided) return false;

  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  if (!secret) return false;

  const message = Object.keys(params)
    .filter((k) => k !== "signature")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");

  const a = Buffer.from(digest, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}
