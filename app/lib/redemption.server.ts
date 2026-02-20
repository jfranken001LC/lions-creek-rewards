import db from "../db.server";
import { apiVersion } from "../shopify.server";
import { RedemptionStatus } from "@prisma/client";
import { getOrCreateShopSettings } from "./shopSettings.server";
import { fetchCustomerTags, resolveEligibleCollectionGid, type AdminGraphql } from "./shopifyQueries.server";

export type IssueRedemptionArgs = {
  shop: string;
  customerId: string;
  pointsRequested: number;
  idempotencyKey?: string;
};

export type IssueRedemptionResult =
  | {
      ok: true;
      code: string;
      expiresAt: string;
      pointsRedeemed: number;
      discountAmount: number;
      newBalance: number;
      idempotencyKey?: string;
    }
  | { ok: false; error: string };

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const sess = await db.session.findUnique({ where: { id } }).catch(() => null);
  return sess?.accessToken ?? null;
}

function makeAdminGraphql(shop: string, accessToken: string): AdminGraphql {
  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  return async (query: string, args?: { variables?: Record<string, any> }) => {
    return fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables: args?.variables ?? {} }),
    });
  };
}

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n);
}

function formatMoney(dollars: number): string {
  const n = Number(dollars);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

async function createDiscount(args: {
  adminGraphql: AdminGraphql;
  title: string;
  discountCode: string;
  valueDollars: number;
  eligibleCollectionGid: string;
  startsAt: string;
  endsAt: string;
  minOrderDollars: number;
}): Promise<{ ok: true; code: string; discountNodeId: string } | { ok: false; error: string }> {
  const mutation = `#graphql
    mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
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

  const minOrder = Number(args.minOrderDollars ?? 0);
  const minimumRequirement =
    Number.isFinite(minOrder) && minOrder > 0
      ? { subtotal: { greaterThanOrEqualToSubtotal: formatMoney(minOrder) } }
      : undefined;

  const variables: Record<string, any> = {
    basicCodeDiscount: {
      title: args.title,
      code: args.discountCode,
      startsAt: args.startsAt,
      endsAt: args.endsAt,

      // Required in modern API versions (deprecated customerSelection is intentionally avoided)
      context: { all: "ALL" },

      // Minimum order requirement (subtotal) if configured
      ...(minimumRequirement ? { minimumRequirement } : {}),

      // Fixed amount off (applies to eligible collection)
      customerGets: {
        value: { discountAmount: { amount: formatMoney(args.valueDollars), appliesOnEachItem: false } },
        items: { collections: { add: [args.eligibleCollectionGid] } },
      },

      usageLimit: 1,

      combinesWith: {
        orderDiscounts: true,
        productDiscounts: true,
        shippingDiscounts: true,
      },
    },
  };

  const res = await args.adminGraphql(mutation, { variables });
  const json = (await res.json().catch(() => null)) as any;

  const topErr = json?.errors?.[0]?.message;
  const userErr = json?.data?.discountCodeBasicCreate?.userErrors?.[0]?.message;
  if (!res.ok || topErr || userErr) {
    return { ok: false, error: String(userErr || topErr || `HTTP ${res.status}`) };
  }

  const node = json?.data?.discountCodeBasicCreate?.codeDiscountNode;
  const code = node?.codeDiscount?.codes?.nodes?.[0]?.code;
  const discountNodeId = node?.id;
  if (!code || !discountNodeId) return { ok: false, error: "Discount creation failed (missing code/node id)." };

  return { ok: true, code, discountNodeId };
}

async function getActiveRedemption(args: { shop: string; customerId: string }) {
  return db.redemption.findFirst({
    where: {
      shop: args.shop,
      customerId: args.customerId,
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      expiresAt: { gt: new Date() },
    },
    select: { id: true, code: true, status: true, expiresAt: true },
  });
}

export async function issueRedemptionCode(args: IssueRedemptionArgs): Promise<IssueRedemptionResult> {
  const shop = String(args.shop || "").trim();
  const customerId = String(args.customerId || "").trim();
  const pointsRequested = Number(args.pointsRequested);

  if (!shop) return { ok: false, error: "Missing shop" };
  if (!customerId) return { ok: false, error: "Missing customerId" };
  if (!Number.isFinite(pointsRequested) || !Number.isInteger(pointsRequested) || pointsRequested <= 0) {
    return { ok: false, error: "Invalid pointsToRedeem" };
  }

  const settings = await getOrCreateShopSettings(shop);
  const steps = Array.isArray(settings.redemptionSteps) ? settings.redemptionSteps : [];
  if (!steps.length) return { ok: false, error: "No redemption steps configured" };
  if (!steps.includes(pointsRequested)) return { ok: false, error: "Requested points not permitted" };

  const valueDollarsRaw = settings.redemptionValueMap?.[String(pointsRequested)];
  const valueDollars = Number(valueDollarsRaw);
  if (!Number.isFinite(valueDollars) || valueDollars <= 0) return { ok: false, error: "Invalid redemption mapping" };

  // Idempotency: if the same client request is replayed, return the already-issued code + current balance.
  if (args.idempotencyKey) {
    const idemKey = String(args.idempotencyKey).trim();
    if (idemKey) {
      const existing = await db.redemption.findUnique({
        where: { idempotencyKey: idemKey },
        select: { code: true, expiresAt: true, points: true, valueDollars: true },
      });

      if (existing) {
        const bal = await db.customerPointsBalance.findUnique({
          where: { shop_customerId: { shop, customerId } },
          select: { balance: true },
        });

        if (!bal) return { ok: false, error: "Points balance record missing for customer." };

        return {
          ok: true,
          code: existing.code,
          expiresAt: (existing.expiresAt ?? new Date()).toISOString(),
          pointsRedeemed: existing.points,
          discountAmount: existing.valueDollars,
          newBalance: bal.balance,
          idempotencyKey: idemKey,
        };
      }
    }
  }

  const accessToken = await getOfflineAccessToken(shop);
  if (!accessToken) return { ok: false, error: "Missing offline access token" };

  const admin = makeAdminGraphql(shop, accessToken);

  // Guardrail: excluded customer tags cannot redeem.
  const tags = await fetchCustomerTags(admin, customerId).catch(() => []);
  if (settings.excludedCustomerTags?.length) {
    const excluded = new Set(settings.excludedCustomerTags.map((t) => String(t).toLowerCase()));
    const customerTags = new Set((tags || []).map((t) => String(t).toLowerCase()));
    for (const t of excluded) {
      if (customerTags.has(t)) return { ok: false, error: "Customer is not eligible for loyalty redemption." };
    }
  }

  // Ensure the eligible collection GID is cached/resolved.
  const eligibleCollectionGid = await resolveEligibleCollectionGid(admin, shop, {
    eligibleCollectionHandle: settings.eligibleCollectionHandle,
    eligibleCollectionGid: settings.eligibleCollectionGid,
  });

  // Fetch points balance (create row if missing).
  const bal = await db.customerPointsBalance.upsert({
    where: { shop_customerId: { shop, customerId } },
    create: { shop, customerId },
    update: {},
    select: { balance: true },
  });

  if (bal.balance < pointsRequested) return { ok: false, error: "Insufficient points" };

  // Guardrail: prevent multiple active redemptions (default-on).
  const active = await getActiveRedemption({ shop, customerId });
  if (active) return { ok: false, error: "Active redemption already exists" };

  // Create a discount code (Shopify) first, then persist + debit points.
  const now = new Date();
  const expires = new Date(now.getTime() + settings.redemptionExpiryHours * 60 * 60 * 1000);

  const discountTitle = `LCR Rewards – $${valueDollars} off (redeem ${pointsRequested})`;
  const discountCode = `LCR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const created = await createDiscount({
    adminGraphql: admin,
    title: discountTitle,
    discountCode,
    valueDollars,
    eligibleCollectionGid,
    startsAt: now.toISOString(),
    endsAt: expires.toISOString(),
    minOrderDollars: settings.redemptionMinOrder,
  });

  if (!created.ok) return { ok: false, error: created.error };

  let newBalance: number | null = null;

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.customerPointsBalance.update({
        where: { shop_customerId: { shop, customerId } },
        data: {
          balance: { decrement: pointsRequested },
          lifetimeRedeemed: { increment: pointsRequested },
          lastActivityAt: new Date(),
        },
        select: { balance: true },
      });

      newBalance = updated.balance;

      await tx.redemption.create({
        data: {
          shop,
          customerId,
          code: created.code,
          points: pointsRequested,
          valueDollars: isInt(valueDollars) ? valueDollars : Math.round(valueDollars),
          status: RedemptionStatus.ISSUED,
          discountNodeId: created.discountNodeId,
          createdAt: now,
          expiresAt: expires,
          idempotencyKey: args.idempotencyKey ? String(args.idempotencyKey).trim() : null,
        },
      });
    });
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Failed to record redemption" };
  }

  if (newBalance === null) return { ok: false, error: "Failed to compute new balance" };

  return {
    ok: true,
    code: created.code,
    expiresAt: expires.toISOString(),
    pointsRedeemed: pointsRequested,
    discountAmount: valueDollars,
    newBalance,
    idempotencyKey: args.idempotencyKey ? String(args.idempotencyKey).trim() : undefined,
  };
}
