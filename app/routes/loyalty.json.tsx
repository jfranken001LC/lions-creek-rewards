// app/routes/loyalty.json.tsx
import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";
import { getShopSettings } from "../lib/shopSettings.server";

function verifyProxySignature(url: URL, secret: string): boolean {
  // Shopify app proxy signs with "signature" (legacy) or "hmac" depending on config.
  const signature = url.searchParams.get("signature");
  const hmac = url.searchParams.get("hmac");
  const provided = signature ?? hmac;
  if (!provided) return false;

  // Build message from sorted query params excluding signature/hmac
  const params = Array.from(url.searchParams.entries())
    .filter(([k]) => k !== "signature" && k !== "hmac")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("");

  const digest = crypto.createHmac("sha256", secret).update(params).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(provided, "utf8"));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const customerId = url.searchParams.get("logged_in_customer_id");

  if (!shop || !customerId) {
    return data({ ok: false, error: "Missing shop or logged_in_customer_id" }, { status: 400 });
  }

  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  if (!secret || !verifyProxySignature(url, secret)) {
    return data({ ok: false, error: "Invalid proxy signature" }, { status: 401 });
  }

  const settings = await getShopSettings(shop);

  const bal = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });

  const now = new Date();
  const lastActivityAt = bal?.lastActivityAt ?? null;

  // Estimated expiry = last activity + 365 days (per FR-2.3); adjust if you later make this configurable.
  const estimatedExpiryAt =
    lastActivityAt ? new Date(lastActivityAt.getTime() + 365 * 86400000) : null;

  // Active redemption (if any)
  const activeRedemption = await db.redemption.findFirst({
    where: {
      shop,
      customerId,
      status: { in: ["ISSUED", "APPLIED"] } as any,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: "desc" },
    select: { code: true, value: true, points: true, status: true, expiresAt: true, issuedAt: true },
  });

  return data({
    ok: true,
    shop,
    customerId,
    points: {
      balance: bal?.balance ?? 0,
      lifetimeEarned: bal?.lifetimeEarned ?? 0,
      lifetimeRedeemed: bal?.lifetimeRedeemed ?? 0,
      lastActivityAt,
      estimatedExpiryAt,
      expiredAt: bal?.expiredAt ?? null,
    },
    activeRedemption,
    // Minimal merchant-config surface for dashboard UI
    settings: {
      earnRate: settings.earnRate,
      redemptionMinOrderCad: settings.redemptionMinOrderCad,
      codeExpiryDays: settings.codeExpiryDays,
    },
  });
};
