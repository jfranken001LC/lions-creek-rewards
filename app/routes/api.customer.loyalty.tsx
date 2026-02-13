import { json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopSettings } from "../lib/shopSettings.server";
import { RedemptionStatus } from "@prisma/client";

/**
 * Customer Account UI Extension endpoint.
 *
 * Auth: Authorization: Bearer <customer account session token>
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken } = await authenticate.public.customerAccount(request);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return cors(new Response(null, { status: 204 }));
  }

  const shop = sessionToken?.dest?.replace(/^https:\/\//, "") ?? "";
  const customerGid = sessionToken?.sub ?? "";
  const customerId = customerGid.replace(/^gid:\/\/shopify\/Customer\//, "");

  if (!shop || !customerId) {
    return cors(json({ ok: false, error: "Missing shop or customer identity" }, { status: 401 }));
  }

  const settings = await getShopSettings(shop);

  // Ensure the row exists (so first-time customers don't 404)
  const balanceRow =
    (await db.customerPointsBalance.findUnique({
      where: { shop_customerId: { shop, customerId } },
    })) ??
    (await db.customerPointsBalance.create({
      data: {
        shop,
        customerId,
        balance: 0,
        lifetimeEarned: 0,
        lifetimeRedeemed: 0,
      },
    }));

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
      value: true,
      points: true,
      status: true,
      expiresAt: true,
    },
  });

  const catalog = (settings.redemptionSteps ?? [])
    .map((step) => {
      const points = Number(step.points);
      const valueDollars = Number(settings.redemptionValueMap?.[points] ?? 0);
      return {
        points,
        valueDollars,
        minimumOrderDollars: settings.redemptionMinOrder,
      };
    })
    .filter((c) => c.points > 0 && c.valueDollars > 0);

  return cors(
    json({
      ok: true,
      pointsBalance: balanceRow.balance,
      pointsLifetimeEarned: balanceRow.lifetimeEarned,
      pointsLifetimeRedeemed: balanceRow.lifetimeRedeemed,
      pointsLastActivityAt: balanceRow.lastActivityAt?.toISOString?.() ?? null,
      ledger: ledger.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
      redemptionActive: redemptionActive
        ? {
            id: redemptionActive.id,
            code: redemptionActive.code,
            valueCents: Math.round(Number(redemptionActive.value) * 100),
            minimumSubtotalCents: Math.round(settings.redemptionMinOrder * 100),
            status: redemptionActive.status,
            expiresAt: (redemptionActive.expiresAt ?? new Date(now.getTime() + 72 * 60 * 60 * 1000)).toISOString(),
          }
        : null,
      catalog,
      copy: {
        earn: `Earn ${settings.earnRate} point(s) for every $1 you spend on eligible items (after discounts).`,
        expiry: "Points expire after 12 months of inactivity.",
      },
    }),
  );
};
