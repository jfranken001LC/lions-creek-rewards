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
  return s;
}

function centsToMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function makeCode(): string {
  const part = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `LCR-${part}`;
}

async function adminGraphql(shop: string, accessToken: string, query: string, variables: any) {
  const resp = await fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = json?.errors?.[0]?.message ?? `Admin GraphQL failed (${resp.status})`;
    throw new Error(msg);
  }
  return json;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.customerAccount(request);
  return new Response(null, { status: 204 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken } = await authenticate.public.customerAccount(request);

  const shop = normalizeShopFromDest(sessionToken.dest);
  const customerId = customerIdFromSub(sessionToken.sub);
  const customerGid = sessionToken.sub; // gid://shopify/Customer/...

  const settings = await getShopSettings(shop);

  const { points } = await request.json().catch(() => ({ points: 0 }));
  const pointsRequested = Math.floor(Number(points));

  if (!pointsRequested) {
    return cors(json({ ok: false, error: "Missing points." }, { status: 400 }));
  }

  if (!V1_REDEMPTION_STEPS.includes(pointsRequested as any)) {
    return cors(
      json(
        { ok: false, error: `Invalid redemption amount. Allowed: ${V1_REDEMPTION_STEPS.join(", ")}.` },
        { status: 400 },
      ),
    );
  }

  const dollars = V1_REDEMPTION_VALUE_MAP[String(pointsRequested)] ?? 0;
  const valueCents = dollars * 100;

  // if there is an active redemption, return it
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
    return cors(
      json({
        ok: true,
        alreadyIssued: true,
        code: active.code,
        expiresAt: active.expiresAt.toISOString(),
        redemptionId: active.id,
        valueCents: active.valueCents,
        minimumSubtotalCents: active.minimumSubtotalCents,
      }),
    );
  }

  const balance = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });

  const currentPoints = balance?.pointsBalance ?? 0;
  if (currentPoints < pointsRequested) {
    return cors(
      json(
        { ok: false, error: `Insufficient points. You have ${currentPoints}, need ${pointsRequested}.` },
        { status: 400 },
      ),
    );
  }

  const minOrderCents = Math.max(0, settings.redemptionMinOrder * 100);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1000);
  const code = makeCode();
  const idemKey = `${customerId}:${valueCents}:${expiresAt.toISOString().slice(0, 13)}`;

  const idemExisting = await db.redemption.findUnique({
    where: { shop_idemKey: { shop, idemKey } },
  });

  if (idemExisting) {
    return cors(
      json({
        ok: true,
        alreadyIssued: true,
        code: idemExisting.code,
        expiresAt: idemExisting.expiresAt.toISOString(),
        redemptionId: idemExisting.id,
        valueCents: idemExisting.valueCents,
        minimumSubtotalCents: idemExisting.minimumSubtotalCents,
      }),
    );
  }

  // get offline access token
  const offline = await db.session.findFirst({
    where: { shop, isOnline: false },
    orderBy: { id: "desc" },
  });

  if (!offline?.accessToken) {
    return cors(json({ ok: false, error: "Missing offline session for shop." }, { status: 500 }));
  }

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

  const gqlJson = await adminGraphql(shop, offline.accessToken, mutation, variables);

  const userErrors = gqlJson?.data?.discountCodeBasicCreate?.userErrors ?? [];
  if (Array.isArray(userErrors) && userErrors.length) {
    return cors(json({ ok: false, error: userErrors.map((e: any) => e.message).join("; ") }, { status: 400 }));
  }

  const discountNodeId = gqlJson?.data?.discountCodeBasicCreate?.codeDiscountNode?.id;
  if (!discountNodeId) {
    return cors(json({ ok: false, error: "Failed to create discount." }, { status: 500 }));
  }

  const redemption = await db.$transaction(async (tx) => {
    const r = await tx.redemption.create({
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
        sourceId: r.id,
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

    if (updated.pointsBalance < 0) {
      await tx.customerPointsBalance.update({
        where: { shop_customerId: { shop, customerId } },
        data: { pointsBalance: 0 },
      });
    }

    return r;
  });

  return cors(
    json({
      ok: true,
      code: redemption.code,
      expiresAt: redemption.expiresAt.toISOString(),
      redemptionId: redemption.id,
      valueCents: redemption.valueCents,
      minimumSubtotalCents: redemption.minimumSubtotalCents,
    }),
  );
};
