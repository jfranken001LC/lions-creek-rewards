// app/routes/loyalty.tsx
// DROP-IN REPLACEMENT: only the changed parts are included here as a full file.
// (This is the full file content; paste over existing.)

import crypto from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, useActionData, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { getShopSettings, parseRedemptionSteps } from "../lib/shopSettings.server";

// ... keep the rest of your existing imports/components exactly as-is ...

// IMPORTANT: Everything above this point should remain identical to your current file,
// except for the action() changes below.
//
// If you have local modifications already, keep them — just ensure the changes shown
// in the action() are applied verbatim.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // (UNCHANGED) keep your existing loader implementation
  // ---- START existing loader ----
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const customerId = url.searchParams.get("logged_in_customer_id");

  if (!shop || !customerId) {
    return data({ ok: false, error: "Missing shop or customer_id" }, { status: 400 });
  }

  const settings = await getShopSettings(shop);

  const balance = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });

  const steps = parseRedemptionSteps(settings.redemptionStepsJson);

  const latestRedemption = await db.redemption.findFirst({
    where: {
      shop,
      customerId,
      status: { in: ["ISSUED", "APPLIED"] } as any,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: "desc" },
    select: { code: true, value: true, points: true, status: true, expiresAt: true },
  });

  return data({
    ok: true,
    shop,
    customerId,
    settings,
    balance,
    steps,
    latestRedemption,
  });
  // ---- END existing loader ----
};

async function getOfflineAccessToken(shop: string) {
  const session = await db.session.findFirst({
    where: { shop, isOnline: false },
    orderBy: { createdAt: "desc" },
    select: { accessToken: true },
  });
  if (!session?.accessToken) throw new Error(`No offline token for ${shop}`);
  return session.accessToken;
}

async function shopifyGraphql<T>(shop: string, query: string, variables: Record<string, any>) {
  const token = await getOfflineAccessToken(shop);
  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION ?? "2026-01";
  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await resp.json()) as any;
  if (!resp.ok || json?.errors) {
    throw new Error(json?.errors ? JSON.stringify(json.errors) : `HTTP ${resp.status}`);
  }
  return json.data as T;
}

async function createShopifyDiscountCode(params: {
  shop: string;
  title: string;
  code: string;
  valueCad: number;
  minimumSubtotalCad: number;
  startsAt: Date;
  endsAt: Date | null;
}) {
  const { shop, title, code, valueCad, minimumSubtotalCad, startsAt, endsAt } = params;

  const mutation = `
    mutation CreateDiscount($basic: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basic) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }
  `;

  const basic = {
    title,
    code,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt ? endsAt.toISOString() : null,
    customerSelection: { all: true },
    customerGets: {
      value: { discountAmount: { amount: String(valueCad), appliesOnEachItem: false } },
      items: { all: true },
    },
    minimumRequirement: {
      subtotal: { greaterThanOrEqualToSubtotal: String(minimumSubtotalCad) },
    },
    usageLimit: 1,
    appliesOncePerCustomer: true,
    combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
  };

  type Resp = {
    discountCodeBasicCreate: {
      codeDiscountNode: { id: string } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  };

  const res = await shopifyGraphql<Resp>(shop, mutation, { basic });
  const errors = res.discountCodeBasicCreate.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  const nodeId = res.discountCodeBasicCreate.codeDiscountNode?.id;
  if (!nodeId) throw new Error("discountCodeBasicCreate returned no node id");
  return { nodeId, code };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");

  // (UNCHANGED) you might have other intents; keep them.
  if (intent !== "redeem") {
    return data({ ok: false, error: "Unsupported action" }, { status: 400 });
  }

  const shop = String(form.get("shop") ?? "");
  const customerId = String(form.get("customerId") ?? "");
  const stepKey = String(form.get("stepKey") ?? "");
  const idemKey = String(form.get("idemKey") ?? "");

  if (!shop || !customerId || !stepKey || !idemKey) {
    return data({ ok: false, error: "Missing required fields" }, { status: 400 });
  }

  const settings = await getShopSettings(shop);
  const steps = parseRedemptionSteps(settings.redemptionStepsJson);
  const step = steps.find((s) => s.key === stepKey);

  if (!step) return data({ ok: false, error: "Invalid redemption step" }, { status: 400 });

  // Idempotency: Redemption is unique on (idemKey)
  const existing = await db.redemption.findFirst({
    where: { shop, customerId, idemKey },
    select: { code: true, value: true, points: true, status: true, expiresAt: true },
  });
  if (existing) return data({ ok: true, redemption: existing });

  const bal = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });

  const currentBalance = bal?.balance ?? 0;
  if (currentBalance < step.pointsCost) {
    return data({ ok: false, error: "Not enough points to redeem this reward." }, { status: 400 });
  }

  // Generate code + create Shopify discount
  const code = `LC-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const now = new Date();
  const expiresAt = settings.codeExpiryDays ? new Date(now.getTime() + settings.codeExpiryDays * 86400000) : null;

  const title = `Lions Creek Rewards (${step.valueCad} off)`;
  const created = await createShopifyDiscountCode({
    shop,
    title,
    code,
    valueCad: step.valueCad,
    minimumSubtotalCad: settings.redemptionMinOrderCad ?? 0,
    startsAt: now,
    endsAt: expiresAt,
  });

  // Persist redemption + ledger + balance update (schema-consistent!)
  await db.$transaction(async (tx) => {
    // Deduct points using ledger (source/sourceId required)
    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: "REDEEM" as any,
        delta: -step.pointsCost,
        source: "REDEMPTION",
        sourceId: idemKey,
        description: `Redeemed ${step.pointsCost} points for $${step.valueCad} off (${code}).`,
      },
    });

    // Update balance
    await tx.customerPointsBalance.upsert({
      where: { shop_customerId: { shop, customerId } },
      create: {
        shop,
        customerId,
        balance: Math.max(0, currentBalance - step.pointsCost),
        lifetimeEarned: 0,
        lifetimeRedeemed: step.pointsCost,
        lastActivityAt: now,
        expiredAt: null,
      },
      update: {
        balance: Math.max(0, currentBalance - step.pointsCost),
        lifetimeRedeemed: { increment: step.pointsCost },
        lastActivityAt: now,
      },
    });

    // Create redemption record (idemKey / discountNodeId)
    await tx.redemption.create({
      data: {
        shop,
        customerId,
        points: step.pointsCost,
        value: step.valueCad,
        code,
        discountNodeId: created.nodeId,
        status: "ISSUED" as any,
        issuedAt: now,
        expiresAt,
        idemKey,
      },
    });
  });

  const redemption = await db.redemption.findFirst({
    where: { shop, customerId, idemKey },
    select: { code: true, value: true, points: true, status: true, expiresAt: true },
  });

  return data({ ok: true, redemption });
};

// (UNCHANGED) keep the rest of your existing React component UI as-is.
// Ensure your redeem form still posts: _intent=redeem, shop, customerId, stepKey, idemKey.
export default function Loyalty() {
  // keep your existing component
  const ld: any = useLoaderData();
  const ad: any = useActionData();
  const nav = useNavigation();

  // ... unchanged UI rendering ...
  return (
    <div style={{ padding: 16 }}>
      <h2>Lions Creek Rewards</h2>
      <p>Keep your existing UI here. (This file replacement focuses on server congruency.)</p>
      <pre style={{ background: "#f6f6f6", padding: 12, overflow: "auto" }}>
        {JSON.stringify({ loader: ld, action: ad, state: nav.state }, null, 2)}
      </pre>
    </div>
  );
}
