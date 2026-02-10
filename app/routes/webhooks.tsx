import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";

export const loader = async (_args: LoaderFunctionArgs) => {
  return new Response("ok", { status: 200 });
};

function base64ToBuffer(value: string): Buffer | null {
  try {
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}

function verifyShopifyWebhookHmac(rawBody: Buffer, hmacHeader: string | null, apiSecret: string): boolean {
  if (!hmacHeader || !apiSecret) return false;

  const provided = base64ToBuffer(hmacHeader.trim());
  if (!provided) return false;

  const calculated = crypto.createHmac("sha256", apiSecret).update(rawBody).digest();
  if (calculated.length !== provided.length) return false;

  return crypto.timingSafeEqual(calculated, provided);
}

function parseMoney(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  return 0;
}

function clampInt(n: number, min: number, max: number): number {
  const x = Math.floor(n);
  return Math.max(min, Math.min(max, x));
}

function toStringListJson(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v)).map((s) => s.trim()).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v)).map((s) => s.trim()).filter(Boolean);
    } catch {
      // ignore
    }
    return value.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

async function getShopSettings(shop: string) {
  const defaults = {
    earnRate: 1,
    redemptionMinOrder: 0,
    excludedCustomerTags: ["Wholesale"],
    includeProductTags: [],
    excludeProductTags: [],
    redemptionSteps: [500, 1000],
    redemptionValueMap: { "500": 10, "1000": 20 },
  };

  const existing = await db.shopSettings.findUnique({ where: { shop } }).catch(() => null);
  if (!existing) return defaults;

  return {
    ...defaults,
    ...existing,
    excludedCustomerTags: toStringListJson((existing as any).excludedCustomerTags) || defaults.excludedCustomerTags,
    includeProductTags: toStringListJson((existing as any).includeProductTags) || defaults.includeProductTags,
    excludeProductTags: toStringListJson((existing as any).excludeProductTags) || defaults.excludeProductTags,
    redemptionSteps: (existing as any).redemptionSteps ?? defaults.redemptionSteps,
    redemptionValueMap: (existing as any).redemptionValueMap ?? defaults.redemptionValueMap,
  };
}

/** Offline token from PrismaSessionStorage: id = offline_{shop} */
async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const s = await db.session.findUnique({ where: { id } }).catch(() => null);
  return s?.accessToken ?? null;
}

type OrderForPoints = {
  id: string;
  name: string | null;
  currencyCode: string | null;
  customer: { id: string; tags: string[] } | null;
  discountCodes: string[];
  lineItems: Array<{
    quantity: number;
    originalTotal: number;
    allocatedDiscountTotal: number;
    productTags: string[];
  }>;
};

async function fetchOrderForPoints(shop: string, numericOrderId: string): Promise<OrderForPoints | null> {
  const token = await getOfflineAccessToken(shop);
  if (!token) return null;

  const gid = `gid://shopify/Order/${numericOrderId}`;
  const endpoint = `https://${shop}/admin/api/2025-10/graphql.json`;

  const query = `
    query OrderForPoints($id: ID!) {
      order(id: $id) {
        id
        name
        currencyCode
        customer { id tags }
        discountApplications(first: 50) {
          nodes {
            __typename
            ... on DiscountCodeApplication { code }
          }
        }
        lineItems(first: 250) {
          nodes {
            quantity
            originalTotalSet { shopMoney { amount } }
            discountAllocations { allocatedAmountSet { shopMoney { amount } } }
            variant { product { tags } }
          }
        }
      }
    }
  `;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables: { id: gid } }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    console.error(`[webhooks] Admin API order fetch failed ${resp.status} ${resp.statusText} ${t}`);
    return null;
  }

  const json = await resp.json().catch(() => null);
  const order = json?.data?.order;
  if (!order) return null;

  const customer = order.customer
    ? { id: String(order.customer.id), tags: Array.isArray(order.customer.tags) ? order.customer.tags.map((x: any) => String(x)) : [] }
    : null;

  const discountCodes: string[] = Array.isArray(order.discountApplications?.nodes)
    ? order.discountApplications.nodes
        .filter((n: any) => n?.__typename === "DiscountCodeApplication" && n?.code)
        .map((n: any) => String(n.code).trim())
        .filter(Boolean)
    : [];

  const nodes: any[] = order.lineItems?.nodes ?? [];
  const lineItems = nodes.map((n) => {
    const originalTotal = parseMoney(n?.originalTotalSet?.shopMoney?.amount);
    const allocatedDiscountTotal = Array.isArray(n?.discountAllocations)
      ? n.discountAllocations.reduce((sum: number, da: any) => sum + parseMoney(da?.allocatedAmountSet?.shopMoney?.amount), 0)
      : 0;

    const productTags: string[] =
      n?.variant?.product?.tags && Array.isArray(n.variant.product.tags) ? n.variant.product.tags.map((t: any) => String(t)) : [];

    return {
      quantity: Number(n?.quantity ?? 0) || 0,
      originalTotal,
      allocatedDiscountTotal,
      productTags,
    };
  });

  return {
    id: String(order.id),
    name: order.name ? String(order.name) : null,
    currencyCode: order.currencyCode ? String(order.currencyCode) : null,
    customer,
    discountCodes,
    lineItems,
  };
}

function computeEligibleFromOrder(order: OrderForPoints, settings: any): { eligibleNet: number; customerId: string | null; skipReason?: { code: string; message: string } } {
  const excludedCustomerTags: string[] = (settings?.excludedCustomerTags ?? []).map((t: any) => String(t).trim()).filter(Boolean);
  const includeProductTags: string[] = (settings?.includeProductTags ?? []).map((t: any) => String(t).trim()).filter(Boolean);
  const excludeProductTags: string[] = (settings?.excludeProductTags ?? []).map((t: any) => String(t).trim()).filter(Boolean);

  if (!order.customer?.id) {
    return { eligibleNet: 0, customerId: null, skipReason: { code: "GUEST_ORDER", message: "Order has no customer (guest checkout)." } };
  }

  const customerTags = order.customer.tags.map((t) => t.trim()).filter(Boolean);
  const isExcludedCustomer = excludedCustomerTags.length > 0 && customerTags.some((t) => excludedCustomerTags.includes(t));
  if (isExcludedCustomer) {
    return { eligibleNet: 0, customerId: order.customer.id, skipReason: { code: "CUSTOMER_EXCLUDED", message: "Customer excluded by tag rule." } };
  }

  let eligibleNet = 0;

  for (const li of order.lineItems) {
    const tags = (li.productTags ?? []).map((t) => t.trim()).filter(Boolean);

    const includedByTags = includeProductTags.length === 0 || tags.some((t) => includeProductTags.includes(t));
    const excludedByTags = excludeProductTags.length > 0 && tags.some((t) => excludeProductTags.includes(t));
    if (!includedByTags || excludedByTags) continue;

    const net = Math.max(0, li.originalTotal - li.allocatedDiscountTotal);
    eligibleNet += net;
  }

  if (eligibleNet <= 0) {
    return { eligibleNet: 0, customerId: order.customer.id, skipReason: { code: "NO_ELIGIBLE_MERCH", message: "No eligible net merchandise after tag rules/discounts." } };
  }

  return { eligibleNet, customerId: order.customer.id };
}

async function consumeRedemptionsIfUsed(args: { shop: string; customerId: string; orderId: string; usedCodes: string[] }) {
  const usedCodes = (args.usedCodes ?? []).map((c) => String(c).trim()).filter(Boolean);
  if (usedCodes.length === 0) return;

  await db.redemption
    .updateMany({
      where: { shop: args.shop, customerId: args.customerId, status: "ISSUED", code: { in: usedCodes } },
      data: { status: "CONSUMED", consumedAt: new Date(), consumedOrderId: args.orderId },
    })
    .catch(() => null);
}

async function markWebhookOutcome(params: {
  eventId: string;
  outcome: "RECEIVED" | "PROCESSED" | "SKIPPED" | "FAILED";
  code?: string | null;
  message?: string | null;
}) {
  const { eventId, outcome, code, message } = params;
  await db.webhookEvent
    .update({
      where: { id: eventId },
      data: {
        outcome,
        outcomeCode: code ?? null,
        outcomeMessage: message ?? null,
        processedAt: new Date(),
      },
    })
    .catch(() => null);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("ok", { status: 200 });

  const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";
  const hmac = request.headers.get("X-Shopify-Hmac-Sha256") ?? request.headers.get("X-Shopify-Hmac-SHA256");
  const topic = (request.headers.get("X-Shopify-Topic") ?? "").trim().toLowerCase();
  const shop = (request.headers.get("X-Shopify-Shop-Domain") ?? "").trim().toLowerCase();
  const webhookId = request.headers.get("X-Shopify-Webhook-Id") ?? crypto.randomUUID();

  const rawBodyBuffer = Buffer.from(await request.arrayBuffer());
  if (!verifyShopifyWebhookHmac(rawBodyBuffer, hmac, apiSecret)) {
    return new Response("Invalid webhook signature", { status: 401 });
  }

  let payload: any = {};
  try {
    payload = JSON.parse(rawBodyBuffer.toString("utf8") || "{}");
  } catch {
    payload = {};
  }

  // Idempotency: record webhookId (unique constraint)
  let eventRow: any;
  try {
    eventRow = await db.webhookEvent.create({
      data: {
        shop,
        webhookId: String(webhookId),
        topic,
        resourceId: String(payload?.id ?? payload?.order_id ?? payload?.admin_graphql_api_id ?? ""),
        receivedAt: new Date(),
        outcome: "RECEIVED",
      },
    });
  } catch {
    return new Response(null, { status: 200 });
  }

  const eventId = String(eventRow?.id ?? "");

  try {
    if (!shop) {
      await markWebhookOutcome({ eventId, outcome: "SKIPPED", code: "MISSING_SHOP", message: "Missing shop domain header." });
      return new Response(null, { status: 200 });
    }

    switch (topic) {
      case "orders/paid": {
        const settings = await getShopSettings(shop);

        const orderId = String(payload?.id ?? "");
        if (!orderId) {
          await markWebhookOutcome({ eventId, outcome: "SKIPPED", code: "MISSING_ORDER_ID", message: "Missing payload.id for order." });
          break;
        }

        // Award idempotency: if we already made a snapshot, treat as SKIPPED (duplicate)
        const existing = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } } });
        if (existing) {
          await markWebhookOutcome({ eventId, outcome: "SKIPPED", code: "DUPLICATE_ORDER_PAID", message: "Order already processed (snapshot exists)." });
          break;
        }

        // Prefer Admin API for accurate eligible net + used discount codes
        const order = await fetchOrderForPoints(shop, orderId);
        if (!order) {
          // If Admin API fails, you can decide whether to skip or fallback.
          // Here: SKIP because accurate eligibility is required for audit-grade points.
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "ADMIN_FETCH_FAILED",
            message: "Could not fetch order via Admin API; skipped awarding points.",
          });
          break;
        }

        const currency = order.currencyCode ?? String(payload?.currency ?? "CAD");
        const orderName = order.name ?? (payload?.name ? String(payload.name) : orderId);

        const computed = computeEligibleFromOrder(order, settings);
        const eligibleNet = computed.eligibleNet;
        const customerId = computed.customerId;

        if (!customerId) {
          await markWebhookOutcome({ eventId, outcome: "SKIPPED", code: computed.skipReason?.code ?? "GUEST_ORDER", message: computed.skipReason?.message ?? "Guest order." });
          break;
        }

        if (computed.skipReason) {
          // Also consume redemption codes if they used one (even if points aren’t awarded)
          if (order.discountCodes?.length) {
            await consumeRedemptionsIfUsed({ shop, customerId, orderId, usedCodes: order.discountCodes });
          }

          await markWebhookOutcome({ eventId, outcome: "SKIPPED", code: computed.skipReason.code, message: computed.skipReason.message });
          break;
        }

        // Mark redemption code consumption if used
        if (order.discountCodes?.length) {
          await consumeRedemptionsIfUsed({ shop, customerId, orderId, usedCodes: order.discountCodes });
        }

        const earnRate = Number(settings.earnRate ?? 1) || 1;
        const pointsEarned = clampInt(eligibleNet * earnRate, 0, 10_000_000);

        // If pointsEarned ends up 0 for any reason, treat as SKIPPED for audit clarity
        if (pointsEarned <= 0) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "ZERO_POINTS",
            message: "Eligible net computed, but points earned is 0 based on earnRate.",
          });
          break;
        }

        await db.$transaction(async (tx) => {
          await tx.orderPointsSnapshot.create({
            data: {
              shop,
              orderId,
              customerId,
              eligibleNetMerchandise: eligibleNet,
              pointsAwarded: pointsEarned,
              pointsReversedToDate: 0,
              paidAt: payload?.paid_at ? new Date(payload.paid_at) : new Date(),
              currency,
            },
          });

          await tx.pointsLedger.create({
            data: {
              shop,
              customerId,
              type: "EARN",
              delta: pointsEarned,
              source: "ORDER",
              sourceId: orderId,
              description: `Earned on order ${orderName}`,
              createdAt: new Date(),
            },
          });

          const balanceRow = await tx.customerPointsBalance.upsert({
            where: { shop_customerId: { shop, customerId } },
            create: {
              shop,
              customerId,
              balance: pointsEarned,
              lifetimeEarned: pointsEarned,
              lifetimeRedeemed: 0,
              lastActivityAt: new Date(),
            },
            update: {
              balance: { increment: pointsEarned },
              lifetimeEarned: { increment: pointsEarned },
              lastActivityAt: new Date(),
            },
          });

          if (balanceRow.balance < 0) {
            await tx.customerPointsBalance.update({ where: { shop_customerId: { shop, customerId } }, data: { balance: 0 } });
          }
        });

        await markWebhookOutcome({
          eventId,
          outcome: "PROCESSED",
          code: "POINTS_AWARDED",
          message: `Awarded ${pointsEarned} points on eligible net ${eligibleNet.toFixed(2)} ${currency}.`,
        });

        break;
      }

      // Leave the rest as-is (refunds/cancelled/etc.) — optionally also add outcomes there later
      default:
        await markWebhookOutcome({ eventId, outcome: "PROCESSED", code: "IGNORED_TOPIC", message: `No handler for topic ${topic}.` });
        break;
    }
  } catch (err) {
    console.error(`[webhooks] error topic=${topic} shop=${shop}`, err);

    await db.webhookError
      .create({
        data: {
          shop,
          topic,
          webhookId: String(webhookId),
          error: String((err as any)?.message ?? err),
          createdAt: new Date(),
        },
      })
      .catch(() => null);

    if (eventId) {
      await markWebhookOutcome({
        eventId,
        outcome: "FAILED",
        code: "EXCEPTION",
        message: String((err as any)?.message ?? err),
      });
    }
  }

  return new Response(null, { status: 200 });
};
