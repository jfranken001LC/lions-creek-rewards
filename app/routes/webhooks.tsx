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

function verifyShopifyWebhookHmac(
  rawBody: Buffer,
  hmacHeader: string | null,
  apiSecret: string,
): boolean {
  if (!hmacHeader || !apiSecret) return false;

  const provided = base64ToBuffer(hmacHeader.trim());
  if (!provided) return false;

  const calculated = crypto
    .createHmac("sha256", apiSecret)
    .update(rawBody)
    .digest();

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
    } catch { /* ignore */ }
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

/**
 * Offline token is stored by PrismaSessionStorage with id: offline_{shop}
 */
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
  discountCodes: string[]; // <-- NEW
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

  // NEW: discountApplications for DiscountCodeApplication.code
  const query = `
    query OrderForPoints($id: ID!) {
      order(id: $id) {
        id
        name
        currencyCode
        customer {
          id
          tags
        }
        discountApplications(first: 50) {
          nodes {
            __typename
            ... on DiscountCodeApplication {
              code
            }
          }
        }
        lineItems(first: 250) {
          nodes {
            quantity
            originalTotalSet {
              shopMoney { amount }
            }
            discountAllocations {
              allocatedAmountSet { shopMoney { amount } }
            }
            variant {
              product { tags }
            }
          }
        }
      }
    }
  `;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
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
    ? {
        id: String(order.customer.id),
        tags: Array.isArray(order.customer.tags) ? order.customer.tags.map((x: any) => String(x)) : [],
      }
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
      ? n.discountAllocations.reduce((sum: number, da: any) => {
          return sum + parseMoney(da?.allocatedAmountSet?.shopMoney?.amount);
        }, 0)
      : 0;

    const productTags: string[] =
      n?.variant?.product?.tags && Array.isArray(n.variant.product.tags)
        ? n.variant.product.tags.map((t: any) => String(t))
        : [];

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

function computeEligibleFromOrder(order: OrderForPoints, settings: any): { eligibleNet: number; customerId: string | null } {
  const excludedCustomerTags: string[] = (settings?.excludedCustomerTags ?? [])
    .map((t: any) => String(t).trim())
    .filter(Boolean);

  const includeProductTags: string[] = (settings?.includeProductTags ?? [])
    .map((t: any) => String(t).trim())
    .filter(Boolean);

  const excludeProductTags: string[] = (settings?.excludeProductTags ?? [])
    .map((t: any) => String(t).trim())
    .filter(Boolean);

  if (!order.customer?.id) return { eligibleNet: 0, customerId: null };

  const customerTags = order.customer.tags.map((t) => t.trim()).filter(Boolean);
  const isExcludedCustomer =
    excludedCustomerTags.length > 0 &&
    customerTags.some((t) => excludedCustomerTags.includes(t));

  if (isExcludedCustomer) return { eligibleNet: 0, customerId: order.customer.id };

  let eligibleNet = 0;

  for (const li of order.lineItems) {
    const tags = (li.productTags ?? []).map((t) => t.trim()).filter(Boolean);

    const includedByTags =
      includeProductTags.length === 0 || tags.some((t) => includeProductTags.includes(t));
    const excludedByTags =
      excludeProductTags.length > 0 && tags.some((t) => excludeProductTags.includes(t));

    if (!includedByTags || excludedByTags) continue;

    // Eligible net merch = originalTotal - allocatedDiscountTotal (never below 0)
    const net = Math.max(0, li.originalTotal - li.allocatedDiscountTotal);
    eligibleNet += net;
  }

  return { eligibleNet, customerId: order.customer.id };
}

function computeEligibleNetMerchandiseFallback(payload: any, settings: any): { eligibleNet: number } {
  const customer = payload?.customer;
  const customerTags: string[] =
    typeof customer?.tags === "string"
      ? customer.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
      : Array.isArray(customer?.tags)
        ? customer.tags
        : [];

  const excludedCustomerTags: string[] = (settings?.excludedCustomerTags ?? [])
    .map((t: string) => String(t).trim())
    .filter(Boolean);

  const isExcludedCustomer =
    excludedCustomerTags.length > 0 &&
    customerTags.some((t) => excludedCustomerTags.includes(t));

  if (!payload?.customer?.id || isExcludedCustomer) {
    return { eligibleNet: 0 };
  }

  // Tag logic is best-effort only in fallback
  const includeProductTags: string[] = (settings?.includeProductTags ?? [])
    .map((t: string) => String(t).trim())
    .filter(Boolean);
  const excludeProductTags: string[] = (settings?.excludeProductTags ?? [])
    .map((t: string) => String(t).trim())
    .filter(Boolean);

  const lines: any[] = Array.isArray(payload?.line_items) ? payload.line_items : [];
  let eligibleNet = 0;

  for (const li of lines) {
    const qty = Number(li?.quantity ?? 0) || 0;
    const unitPrice = parseMoney(li?.price);
    const gross = unitPrice * qty;

    let discount = 0;
    if (Array.isArray(li?.discount_allocations)) {
      discount = li.discount_allocations.reduce((sum: number, da: any) => {
        const v =
          parseMoney(da?.amount) ||
          parseMoney(da?.amount_set?.shop_money?.amount) ||
          0;
        return sum + v;
      }, 0);
    } else {
      discount = parseMoney(li?.total_discount) || 0;
    }

    const lineTags: string[] =
      typeof li?.tags === "string"
        ? li.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
        : Array.isArray(li?.tags)
          ? li.tags
          : [];

    const includedByTags =
      includeProductTags.length === 0 || lineTags.some((t) => includeProductTags.includes(t));
    const excludedByTags =
      excludeProductTags.length > 0 && lineTags.some((t) => excludeProductTags.includes(t));

    if (!includedByTags || excludedByTags) continue;

    const net = Math.max(0, gross - discount);
    eligibleNet += net;
  }

  return { eligibleNet };
}

/**
 * NEW: Mark any matching issued redemption codes as CONSUMED when used on a paid order.
 * - We tie to customerId (required) + shop + code + status=ISSUED.
 * - We store consumedAt + consumedOrderId for auditability.
 */
async function consumeRedemptionsIfUsed(args: {
  shop: string;
  customerId: string;
  orderId: string;
  usedCodes: string[];
}) {
  const { shop, customerId, orderId } = args;
  const usedCodes = (args.usedCodes ?? []).map((c) => String(c).trim()).filter(Boolean);
  if (usedCodes.length === 0) return;

  await db.redemption.updateMany({
    where: {
      shop,
      customerId,
      status: "ISSUED",
      code: { in: usedCodes },
    },
    data: {
      status: "CONSUMED",
      consumedAt: new Date(),
      consumedOrderId: orderId,
    },
  }).catch(() => null);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("ok", { status: 200 });

  const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";
  const hmac =
    request.headers.get("X-Shopify-Hmac-Sha256") ??
    request.headers.get("X-Shopify-Hmac-SHA256");

  const topic = (request.headers.get("X-Shopify-Topic") ?? "").trim().toLowerCase();
  const shop = (request.headers.get("X-Shopify-Shop-Domain") ?? "").trim().toLowerCase();

  const webhookId =
    request.headers.get("X-Shopify-Webhook-Id") ??
    crypto.randomUUID();

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

  // Idempotency: record webhookId (unique)
  try {
    await db.webhookEvent.create({
      data: {
        shop,
        webhookId: String(webhookId),
        topic,
        resourceId: String(payload?.id ?? payload?.order_id ?? payload?.admin_graphql_api_id ?? ""),
        receivedAt: new Date(),
      },
    });
  } catch {
    return new Response(null, { status: 200 });
  }

  try {
    if (!shop) return new Response(null, { status: 200 });

    switch (topic) {
      case "app/uninstalled": {
        await db.session.deleteMany({ where: { shop } });
        await db.shopSettings.deleteMany({ where: { shop } });
        break;
      }

      case "orders/paid": {
        const settings = await getShopSettings(shop);

        const orderId = String(payload?.id ?? "");
        if (!orderId) break;

        // If already processed, stop (awards idempotency)
        const existing = await db.orderPointsSnapshot.findUnique({
          where: { shop_orderId: { shop, orderId } },
        });
        if (existing) break;

        // Preferred: fetch order and compute eligible net via final discount allocations
        let eligibleNet = 0;
        let customerId: string | null = payload?.customer?.id ? String(payload.customer.id) : null;
        let currency = String(payload?.currency ?? "CAD");
        let orderName = payload?.name ? String(payload.name) : orderId;

        const order = await fetchOrderForPoints(shop, orderId);
        if (order) {
          const computed = computeEligibleFromOrder(order, settings);
          eligibleNet = computed.eligibleNet;
          customerId = computed.customerId;
          currency = order.currencyCode ?? currency;
          orderName = order.name ?? orderName;

          // NEW: if the order used a loyalty code, mark it consumed
          if (customerId && order.discountCodes?.length) {
            await consumeRedemptionsIfUsed({
              shop,
              customerId,
              orderId,
              usedCodes: order.discountCodes,
            });
          }
        } else {
          // Fallback if Admin API fails (no consumption marking here)
          const fallback = computeEligibleNetMerchandiseFallback(payload, settings);
          eligibleNet = fallback.eligibleNet;
        }

        if (!customerId) break; // guest orders

        const earnRate = Number(settings.earnRate ?? 1) || 1;
        const pointsEarned = clampInt(eligibleNet * earnRate, 0, 10_000_000);

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

          if (pointsEarned !== 0) {
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
          }

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
            await tx.customerPointsBalance.update({
              where: { shop_customerId: { shop, customerId } },
              data: { balance: 0 },
            });
          }
        });

        break;
      }

      case "refunds/create": {
        const orderId = String(payload?.order_id ?? payload?.order?.id ?? "");
        if (!orderId) break;

        const snap = await db.orderPointsSnapshot.findUnique({
          where: { shop_orderId: { shop, orderId } },
        });
        if (!snap || snap.pointsAwarded <= 0) break;

        const customerId = snap.customerId;

        const refundLineItems: any[] = Array.isArray(payload?.refund_line_items) ? payload.refund_line_items : [];
        let refundedEligibleNet = 0;

        for (const rli of refundLineItems) {
          const li = rli?.line_item ?? {};
          const qty = Number(rli?.quantity ?? li?.quantity ?? 0) || 0;
          const unitPrice = parseMoney(li?.price);
          const gross = unitPrice * qty;
          const subtotal = parseMoney(rli?.subtotal) || gross;
          refundedEligibleNet += Math.max(0, subtotal);
        }

        const originalEligible = snap.eligibleNetMerchandise || 0;
        if (originalEligible <= 0) break;

        const remainingAwardable = Math.max(0, snap.pointsAwarded - snap.pointsReversedToDate);
        if (remainingAwardable <= 0) break;

        const proportion = Math.min(1, Math.max(0, refundedEligibleNet / originalEligible));
        const pointsToReverse = clampInt(remainingAwardable * proportion, 0, remainingAwardable);
        if (pointsToReverse <= 0) break;

        await db.$transaction(async (tx) => {
          await tx.pointsLedger.create({
            data: {
              shop,
              customerId,
              type: "REVERSAL",
              delta: -pointsToReverse,
              source: "REFUND",
              sourceId: String(payload?.id ?? ""),
              description: `Reversal on refund for order ${orderId}`,
              createdAt: new Date(),
            },
          });

          await tx.customerPointsBalance.update({
            where: { shop_customerId: { shop, customerId } },
            data: {
              balance: { decrement: pointsToReverse },
              lastActivityAt: new Date(),
            },
          });

          await tx.orderPointsSnapshot.update({
            where: { shop_orderId: { shop, orderId } },
            data: {
              pointsReversedToDate: { increment: pointsToReverse },
            },
          });

          const b = await tx.customerPointsBalance.findUnique({
            where: { shop_customerId: { shop, customerId } },
          });
          if (b && b.balance < 0) {
            await tx.customerPointsBalance.update({
              where: { shop_customerId: { shop, customerId } },
              data: { balance: 0 },
            });
          }
        });

        break;
      }

      case "orders/cancelled": {
        const orderId = String(payload?.id ?? "");
        if (!orderId) break;

        const snap = await db.orderPointsSnapshot.findUnique({
          where: { shop_orderId: { shop, orderId } },
        });
        if (!snap || snap.pointsAwarded <= 0) break;

        const remaining = Math.max(0, snap.pointsAwarded - snap.pointsReversedToDate);
        if (remaining <= 0) break;

        const customerId = snap.customerId;

        await db.$transaction(async (tx) => {
          await tx.pointsLedger.create({
            data: {
              shop,
              customerId,
              type: "REVERSAL",
              delta: -remaining,
              source: "CANCEL",
              sourceId: orderId,
              description: `Reversal on cancellation for order ${payload?.name ?? orderId}`,
              createdAt: new Date(),
            },
          });

          await tx.customerPointsBalance.update({
            where: { shop_customerId: { shop, customerId } },
            data: {
              balance: { decrement: remaining },
              lastActivityAt: new Date(),
            },
          });

          await tx.orderPointsSnapshot.update({
            where: { shop_orderId: { shop, orderId } },
            data: {
              pointsReversedToDate: { increment: remaining },
              cancelledAt: payload?.cancelled_at ? new Date(payload.cancelled_at) : new Date(),
            },
          });

          const b = await tx.customerPointsBalance.findUnique({
            where: { shop_customerId: { shop, customerId } },
          });
          if (b && b.balance < 0) {
            await tx.customerPointsBalance.update({
              where: { shop_customerId: { shop, customerId } },
              data: { balance: 0 },
            });
          }
        });

        break;
      }

      case "customers/data_request": {
        await db.privacyEvent.create({
          data: {
            shop,
            topic,
            payloadJson: JSON.stringify(payload ?? {}),
            createdAt: new Date(),
          },
        }).catch(() => null);
        break;
      }

      case "customers/redact": {
        const customerId = payload?.customer?.id ? String(payload.customer.id) : null;
        if (customerId) {
          await db.redemption.deleteMany({ where: { shop, customerId } });
        }
        break;
      }

      case "shop/redact": {
        await db.session.deleteMany({ where: { shop } });
        await db.shopSettings.deleteMany({ where: { shop } });
        await db.customerPointsBalance.deleteMany({ where: { shop } });
        await db.pointsLedger.deleteMany({ where: { shop } });
        await db.orderPointsSnapshot.deleteMany({ where: { shop } });
        await db.redemption.deleteMany({ where: { shop } });
        await db.webhookEvent.deleteMany({ where: { shop } });
        await db.webhookError.deleteMany({ where: { shop } });
        await db.privacyEvent.deleteMany({ where: { shop } });
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error(`[webhooks] error topic=${topic} shop=${shop}`, err);
    await db.webhookError.create({
      data: {
        shop,
        topic,
        webhookId: String(webhookId),
        error: String((err as any)?.message ?? err),
        createdAt: new Date(),
      },
    }).catch(() => null);
  }

  return new Response(null, { status: 200 });
};
