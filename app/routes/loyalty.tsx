import {
  json,
  LoaderFunctionArgs,
  ActionFunctionArgs,
} from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getShopSettings, V1_REDEMPTION_STEPS, V1_REDEMPTION_VALUE_MAP } from "../lib/shopSettings.server";

type LedgerRow = {
  id: string;
  type: string;
  delta: number;
  description: string | null;
  createdAt: string;
};

function toInt(n: any, fallback = 0): number {
  const x = Math.floor(Number(n));
  return Number.isFinite(x) ? x : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function centsToMoney(cents: number): string {
  const v = (cents / 100).toFixed(2);
  return `$${v}`;
}

function makeCode(): string {
  // Short, readable, low-collision
  const part = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `LCR-${part}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, appProxy } = await authenticate.public.appProxy(request);

  const shop = session.shop;
  const customerId = appProxy.customerId ? String(appProxy.customerId) : null;

  const settings = await getShopSettings(shop);

  if (!customerId) {
    return json({
      ok: true,
      mode: "app_proxy",
      customerId: null,
      settings,
      balance: null,
      ledger: [],
      redemptionActive: null,
      message: "Not logged in.",
    });
  }

  const balance = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });

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
    ...r,
    createdAt: r.createdAt.toISOString(),
  }));

  const redemptionActive = await db.redemption.findFirst({
    where: {
      shop,
      customerId,
      status: { in: ["ISSUED", "APPLIED"] },
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  return json({
    ok: true,
    mode: "app_proxy",
    customerId,
    settings,
    balance,
    ledger,
    redemptionActive,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, appProxy } = await authenticate.public.appProxy(request);

  const shop = session.shop;
  const customerId = appProxy.customerId ? String(appProxy.customerId) : null;
  const customerGid = appProxy.customerId ? `gid://shopify/Customer/${appProxy.customerId}` : null;

  if (!customerId || !customerGid) {
    return json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const settings = await getShopSettings(shop);

  const body = await request.formData();
  const pointsRequested = toInt(body.get("points"), 0);

  if (!pointsRequested) {
    return json({ ok: false, error: "Missing points." }, { status: 400 });
  }

  // v1 hard lock: only allow 500 or 1000
  if (!V1_REDEMPTION_STEPS.includes(pointsRequested as any)) {
    return json(
      { ok: false, error: `Invalid redemption amount. Allowed: ${V1_REDEMPTION_STEPS.join(", ")}.` },
      { status: 400 },
    );
  }

  const dollars = V1_REDEMPTION_VALUE_MAP[String(pointsRequested)] ?? 0;
  const valueCents = dollars * 100;

  // idempotency (per customer + points): if a live code exists, return it
  const active = await db.redemption.findFirst({
    where: {
      shop,
      customerId,
      status: { in: ["ISSUED", "APPLIED"] },
      expiresAt: { gt: new Date() },
      valueCents,
    },
    orderBy: { createdAt: "desc" },
  });

  if (active) {
    return json({
      ok: true,
      alreadyIssued: true,
      code: active.code,
      expiresAt: active.expiresAt.toISOString(),
      redemptionId: active.id,
      valueCents: active.valueCents,
      minimumSubtotalCents: active.minimumSubtotalCents,
    });
  }

  // balance check
  const balance = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });

  const currentPoints = balance?.pointsBalance ?? 0;
  if (currentPoints < pointsRequested) {
    return json(
      { ok: false, error: `Insufficient points. You have ${currentPoints}, need ${pointsRequested}.` },
      { status: 400 },
    );
  }

  const minOrderCents = Math.max(0, settings.redemptionMinOrder * 100);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1000);
  const code = makeCode();
  const idemKey = `${customerId}:${valueCents}:${expiresAt.toISOString().slice(0, 13)}`; // hourly window

  // Prevent duplicate discount creation
  const idemExisting = await db.redemption.findUnique({
    where: { shop_idemKey: { shop, idemKey } },
  });

  if (idemExisting) {
    return json({
      ok: true,
      alreadyIssued: true,
      code: idemExisting.code,
      expiresAt: idemExisting.expiresAt.toISOString(),
      redemptionId: idemExisting.id,
      valueCents: idemExisting.valueCents,
      minimumSubtotalCents: idemExisting.minimumSubtotalCents,
    });
  }

  // Create discount code in Shopify (Admin GraphQL)
  const mutation = `#graphql
    mutation CreateDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    basicCodeDiscount: {
      title: `LCR Redemption ${code}`,
      code,
      startsAt: now.toISOString(),
      endsAt: expiresAt.toISOString(),
      usageLimit: 1,
      appliesOncePerCustomer: true,
      customerSelection: { customers: { add: [customerGid] } },
      minimumRequirement: minOrderCents
        ? { subtotal: { greaterThanOrEqualToSubtotal: centsToMoney(minOrderCents) } }
        : null,
      customerGets: {
        value: { fixedAmount: { amount: centsToMoney(valueCents), appliesOnEachItem: false } },
        items: { all: true },
      },
    },
  };

  const gqlResp = await admin.graphql(mutation, { variables });
  const gqlJson = await gqlResp.json();

  const userErrors = gqlJson?.data?.discountCodeBasicCreate?.userErrors ?? [];
  if (Array.isArray(userErrors) && userErrors.length) {
    return json(
      { ok: false, error: userErrors.map((e: any) => e.message).join("; ") },
      { status: 400 },
    );
  }

  const discountNodeId = gqlJson?.data?.discountCodeBasicCreate?.codeDiscountNode?.id;
  if (!discountNodeId) {
    return json({ ok: false, error: "Failed to create discount." }, { status: 500 });
  }

  // Commit redemption + ledger + balance update
  const result = await db.$transaction(async (tx) => {
    const redemption = await tx.redemption.create({
      data: {
        shop,
        customerId,
        code,
        discountNodeId,
        valueCents,
        minimumSubtotalCents: minOrderCents,
        status: "ISSUED",
        issuedAt: now,
        expiresAt,
        idemKey,
      },
    });

    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: "REDEEM",
        delta: -pointsRequested,
        source: "REDEMPTION",
        sourceId: redemption.id,
        description: `Redeemed ${pointsRequested} points for ${centsToMoney(valueCents)} code ${code}`,
      },
    });

    const updated = await tx.customerPointsBalance.update({
      where: { shop_customerId: { shop, customerId } },
      data: {
        pointsBalance: { decrement: pointsRequested },
        pointsLifetimeRedeemed: { increment: pointsRequested },
        pointsLastActivityAt: new Date(),
      },
    });

    // guard against negatives (shouldn’t happen due to earlier check)
    if (updated.pointsBalance < 0) {
      await tx.customerPointsBalance.update({
        where: { shop_customerId: { shop, customerId } },
        data: { pointsBalance: 0 },
      });
    }

    return redemption;
  });

  return json({
    ok: true,
    code: result.code,
    expiresAt: result.expiresAt.toISOString(),
    redemptionId: result.id,
    valueCents: result.valueCents,
    minimumSubtotalCents: result.minimumSubtotalCents,
  });
};

export default function LoyaltyRoute() {
  // App proxy routes typically render via Liquid/Storefront. No embedded UI here.
  return null;
}
