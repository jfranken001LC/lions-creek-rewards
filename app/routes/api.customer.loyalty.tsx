import type { ActionFunctionArgs } from "react-router";
import { json } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getShopSettings } from "../lib/shopSettings.server";
import { customerAccountPreflight, withCustomerAccountCors } from "../lib/customerAccountCors.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method.toUpperCase() === "OPTIONS") {
    return customerAccountPreflight();
  }

  if (request.method.toUpperCase() !== "GET") {
    return withCustomerAccountCors(new Response("Method Not Allowed", { status: 405 }));
  }

  try {
    const { sessionToken, customerAccount, shop } = await authenticate.public.customerAccount(request);

    const customerId = String(customerAccount.id);
    const settings = await getShopSettings(shop);

    const balance = await db.customerPointsBalance.findUnique({
      where: { shop_customerId: { shop, customerId } },
    });

    const now = new Date();

    const redemptionActive = await db.redemption.findFirst({
      where: {
        shop,
        customerId,
        status: { in: ["ISSUED", "APPLIED"] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, code: true, points: true, value: true, expiresAt: true, status: true },
    });

    const ledger = await db.pointsLedger.findMany({
      where: { shop, customerId },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, createdAt: true, type: true, delta: true, source: true, description: true },
    });

    const response = json({
      ok: true,
      shop,
      customerId,
      balances: {
        points: balance?.balance ?? 0,
        lifetimeEarned: balance?.lifetimeEarned ?? 0,
        lifetimeRedeemed: balance?.lifetimeRedeemed ?? 0,
        lastActivityAt: balance?.lastActivityAt ? balance.lastActivityAt.toISOString() : null,
        expiredAt: balance?.expiredAt ? balance.expiredAt.toISOString() : null
      },
      settings: {
        earnRate: settings.earnRate,
        includeProductTags: settings.includeProductTags,
        excludeProductTags: settings.excludeProductTags,
        excludedCustomerTags: settings.excludedCustomerTags,
        redemptionSteps: settings.redemptionSteps,
        redemptionValueMap: settings.redemptionValueMap,
        redemptionMinOrder: settings.redemptionMinOrder,
        eligibleCollectionHandle: settings.eligibleCollectionHandle,
        expiry: "Points expire after 12 months of inactivity."
      },
      activeRedemption: redemptionActive
        ? {
            id: redemptionActive.id,
            code: redemptionActive.code,
            points: redemptionActive.points,
            value: redemptionActive.value,
            status: redemptionActive.status,
            expiresAt: redemptionActive.expiresAt
              ? redemptionActive.expiresAt.toISOString()
              : new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString()
          }
        : null,
      recentLedger: ledger.map((l) => ({
        id: l.id,
        createdAt: l.createdAt.toISOString(),
        type: l.type,
        delta: l.delta,
        source: l.source,
        description: l.description
      }))
    });

    return withCustomerAccountCors(response);
  } catch (e: any) {
    const resp = json(
      { ok: false, error: String(e?.message ?? e ?? "Unauthorized") },
      { status: 401 }
    );
    return withCustomerAccountCors(resp);
  }
};
