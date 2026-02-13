import { json, type ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getShopSettings } from "../lib/shopSettings.server";
import { LedgerType, RedemptionStatus } from "@prisma/client";


/**
 * Customer Account UI Extension endpoint: redeem points -> create a Shopify discount code.
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

  const body = await safeJson(request);
  const pointsRequested = Number(body?.points);

  if (!Number.isFinite(pointsRequested) || pointsRequested <= 0) {
    return cors(json({ ok: false, error: "Invalid points" }, { status: 400 }));
  }

  const settings = await getShopSettings(shop);
  const valueDollars = Number(settings.redemptionValueMap?.[pointsRequested] ?? 0);

  if (!valueDollars) {
    return cors(json({ ok: false, error: "Unsupported redemption step" }, { status: 400 }));
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1000); // 72 hours

  // Hour-bucket idempotency key: prevents double-clicks generating multiple codes
  const hourBucket = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const idemKey = `${customerId}:${pointsRequested}:${hourBucket}`;

  const existingByIdem = await db.redemption.findUnique({
    where: { shop_customerId_idemKey: { shop, customerId, idemKey } },
    select: { id: true, code: true, value: true, points: true, status: true, expiresAt: true },
  });

  if (existingByIdem && [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED].includes(existingByIdem.status)) {
    return cors(
      json({
        ok: true,
        code: existingByIdem.code,
        expiresAt: (existingByIdem.expiresAt ?? expiresAt).toISOString(),
      }),
    );
  }

  const active = await db.redemption.findFirst({
    where: {
      shop,
      customerId,
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true, code: true, status: true, expiresAt: true },
  });

  if (active) {
    return cors(
      json({
        ok: false,
        error: "You already have an active discount code. Use it or wait for it to expire.",
      }),
    );
  }

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

  if (balanceRow.balance < pointsRequested) {
    return cors(json({ ok: false, error: `Not enough points. You have ${balanceRow.balance}.` }, { status: 400 }));
  }

  // 1) Create discount in Shopify using offline token
  const discount = await createShopifyDiscountCode({
  shop,
  customerGid,
  code: generateCode(),
  valueDollars,
  minOrderDollars: settings.redemptionMinOrder,
  startsAt: now,
  endsAt: expiresAt,
  eligibleCollectionHandle: settings.eligibleCollectionHandle,
  eligibleCollectionGid: settings.eligibleCollectionGid,
});

  // 2) Persist in DB atomically
  const created = await db.$transaction(async (tx) => {
    const redemption = await tx.redemption.create({
      data: {
        shop,
        customerId,
        points: pointsRequested,
        value: valueDollars,
        code: discount.code,
        discountNodeId: discount.discountNodeId,
        idemKey,
        status: RedemptionStatus.ISSUED,
        expiresAt,
        issuedAt: now,
      },
    });

    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: LedgerType.REDEEM,
        delta: -pointsRequested,
        source: "REDEMPTION",
        sourceId: redemption.id,
        description: `Redeemed ${pointsRequested} points for $${valueDollars.toFixed(0)} off (code ${redemption.code}).`,
      },
    });

    await tx.customerPointsBalance.update({
      where: { shop_customerId: { shop, customerId } },
      data: {
        balance: Math.max(0, balanceRow.balance - pointsRequested),
        lifetimeRedeemed: { increment: pointsRequested },
        lastActivityAt: now,
        expiredAt: null,
      },
    });

    return redemption;
  });

  return cors(
    json({
      ok: true,
      code: created.code,
      expiresAt: (created.expiresAt ?? expiresAt).toISOString(),
    }),
  );
};

function generateCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "LCR-";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function safeJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

ttype CreateDiscountArgs = {
  shop: string;
  customerGid: string;
  code: string;
  valueDollars: number;
  minOrderDollars: number;
  startsAt: Date;
  endsAt: Date;
  eligibleCollectionHandle: string;
  eligibleCollectionGid: string | null;
};

async function resolveEligibleItemsForDiscount(args: {
  shop: string;
  token: string;
  handle: string;
  cachedGid: string | null;
}): Promise<{ collections: { add: string[] } }> {
  if (args.cachedGid) {
    return { collections: { add: [args.cachedGid] } };
  }

  const query = `#graphql
    query EligibleCollectionByHandle($handle: String!) {
      collectionByHandle(handle: $handle) { id }
    }
  `;

  const resp = await adminGraphql(args.shop, args.token, query, { handle: args.handle });
  const gid = resp?.data?.collectionByHandle?.id as string | undefined;

  if (!gid) {
    throw new Error(
      `Eligible collection not found. Create a collection with handle '${args.handle}' (Settings → Eligible collection handle).`,
    );
  }

  // Best-effort cache for faster subsequent mutations.
  try {
    await db.shopSettings.update({ where: { shop: args.shop }, data: { eligibleCollectionGid: gid } });
  } catch {
    // ignore
  }

  return { collections: { add: [gid] } };
}

async function createShopifyDiscountCode(args: CreateDiscountArgs): Promise<{ code: string; discountNodeId: string }> {
  const token = await getOfflineAccessToken(args.shop);
  if (!token) throw new Error(`No offline access token found for shop ${args.shop}`);

  const mutation = `#graphql
    mutation CreateRewardDiscount($discount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $discount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              codes(first: 1) { nodes { code } }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;
const eligibleItems = await resolveEligibleItemsForDiscount({
  shop: args.shop,
  token,
  handle: args.eligibleCollectionHandle,
  cachedGid: args.eligibleCollectionGid,
});
  const variables = {
    discount: {
      title: `Lions Creek Rewards $${args.valueDollars.toFixed(0)} off`,
      code: args.code,
      startsAt: args.startsAt.toISOString(),
      endsAt: args.endsAt.toISOString(),
      usageLimit: 1,
      appliesOncePerCustomer: true,
      customerSelection: { customers: { add: [args.customerGid] } },
      customerGets: {
  // Enforce eligible-merchandise-only discounting via a curated collection.
  items: eligibleItems,
  value: {
    fixedAmount: {
      amount: money(args.valueDollars),
      appliesOnEachItem: false,
    },
  },
},
      minimumRequirement: {
        subtotal: { greaterThanOrEqualToSubtotal: money(args.minOrderDollars) },
      },
    },
  };

  const resp = await adminGraphql(args.shop, token, mutation, variables);
  const errors = resp?.data?.discountCodeBasicCreate?.userErrors ?? [];
  if (errors.length) throw new Error(`Shopify discountCodeBasicCreate userErrors: ${JSON.stringify(errors)}`);

  const node = resp?.data?.discountCodeBasicCreate?.codeDiscountNode;
  const discountNodeId = node?.id;
  const code = node?.codeDiscount?.codes?.nodes?.[0]?.code;

  if (!discountNodeId || !code) throw new Error(`Unexpected Shopify response: ${JSON.stringify(resp)}`);
  return { code, discountNodeId };
}

function money(amount: number): string {
  // Shopify Money inputs are decimal strings without currency symbols.
  return Number(amount).toFixed(2);
}

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const offlineId = `offline_${shop}`;
  const session = await db.session.findUnique({ where: { id: offlineId }, select: { accessToken: true } });
  return session?.accessToken ?? null;
}

async function adminGraphql(shop: string, accessToken: string, query: string, variables?: any) {
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-01";
  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  const jsonResp = JSON.parse(text);

  if (!res.ok || jsonResp.errors) {
    throw new Error(`Shopify GraphQL error (${res.status}): ${JSON.stringify(jsonResp.errors ?? jsonResp)}`);
  }
  return jsonResp;
}
