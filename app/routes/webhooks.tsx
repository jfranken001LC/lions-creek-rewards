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

  const calculated = crypto.createHmac("sha256", apiSecret).update(rawBody).digest();
  if (calculated.length != provided.length) return false;
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

function toStringArray(maybeJson: any): string[] {
  if (!maybeJson) return [];
  if (Array.isArray(maybeJson)) return maybeJson.map(String);
  try {
    const parsed = typeof maybeJson === "string" ? JSON.parse(maybeJson) : maybeJson;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function computeEligibleNetMerchandise(payload: any, settings: any): { eligibleNet: number } {
  const customer = payload?.customer;
  const customerTags: string[] =
    typeof customer?.tags === "string"
      ? customer.tags
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean)
      : Array.isArray(customer?.tags)
        ? customer.tags
        : [];

  const excludedCustomerTags = toStringArray(settings?.excludedCustomerTags).map((t) => t.trim());

  const isExcludedCustomer =
    excludedCustomerTags.length > 0 && customerTags.some((t) => excludedCustomerTags.includes(t));

  if (!payload?.customer?.id || isExcludedCustomer) {
    return { eligibleNet: 0 };
  }

  const includeProductTags = toStringArray(settings?.includeProductTags).map((t) => t.trim());
  const excludeProductTags = toStringArray(settings?.excludeProductTags).map((t) => t.trim());

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
          parseMoney(da?.amount) || parseMoney(da?.amount_set?.shop_money?.amount) || 0;
        return sum + v;
      }, 0);
    } else {
      discount = parseMoney(li?.total_discount) || 0;
    }

    const lineTags: string[] =
      typeof li?.tags === "string"
        ? li.tags
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
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
  return existing ? { ...defaults, ...existing } : defaults;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("ok", { status: 200 });

  const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";
  const hmac =
    request.headers.get("X-Shopify-Hmac-Sha256") ??
    request.headers.get("X-Shopify-Hmac-SHA256");

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
        const customerId = payload?.customer?.id ? String(payload.customer.id) : null;

        if (!orderId || !customerId) break;

        const existing = await db.orderPointsSnapshot.findUnique({
          where: { shop_orderId: { shop, orderId } },
        });
        if (existing) break;

        const { eligibleNet } = computeEligibleNetMerchandise(payload, settings);

        const pointsEarned = clampInt(eligibleNet * (settings.earnRate ?? 1), 0, 10_000_000);

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
              currency: String(payload?.currency ?? "CAD"),
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
                description: `Earned on order ${payload?.name ?? orderId}`,
                createdAt: new Date(),
              },
            });
          }

          const balanceRow = await tx.customerPointsBalance.upsert({
            where: { shop_customerId: { shop, customerId } },
            create: {
              id: crypto.randomUUID(),
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

        const refundLineItems: any[] = Array.isArray(payload?.refund_line_items)
          ? payload.refund_line_items
          : [];
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
        await db.privacyEvent
          .create({
            data: {
              shop,
              topic,
              payloadJson: JSON.stringify(payload ?? {}),
              createdAt: new Date(),
            },
          })
          .catch(() => null);
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
        break;
      }

      default:
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
  }

  return new Response(null, { status: 200 });
};
