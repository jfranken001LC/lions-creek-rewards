import { type ActionFunctionArgs } from "react-router";
import { LedgerType, RedemptionStatus, WebhookOutcome } from "@prisma/client";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getShopSettings } from "../lib/shopSettings.server";

type HandleResult = { outcome: WebhookOutcome; message?: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const started = new Date();
  const { shop, topic, webhookId, payload, admin } = await authenticate.webhook(request);

  const resourceId = extractResourceId(topic, payload);

  const created = await ensureWebhookEventRow({ shop, webhookId, topic, resourceId });
  if (!created) return new Response("ok", { status: 200 });

  try {
    let result: HandleResult;

    switch (topic) {
      case "customers/data_request":
      case "customers/redact":
      case "shop/redact":
        result = await handlePrivacyWebhook(shop, topic, payload);
        break;

      case "orders/paid":
        result = await handleOrdersPaid({ shop, payload, admin });
        break;

      case "refunds/create":
        result = await handleRefundCreate({ shop, payload, admin });
        break;

      case "orders/cancelled":
        result = await handleOrdersCancelled({ shop, payload });
        break;

      default:
        result = { outcome: "SKIPPED", message: `Unhandled topic ${topic}` };
        break;
    }

    await db.webhookEvent.update({
      where: { shop_webhookId: { shop, webhookId } },
      data: { processedAt: new Date(), outcome: result.outcome, outcomeMessage: result.message ?? null },
    });

    return new Response("ok", { status: 200 });
  } catch (e: any) {
    console.error("Webhook processing error:", { shop, topic, webhookId, error: e });

    await db.webhookEvent.update({
      where: { shop_webhookId: { shop, webhookId } },
      data: {
        processedAt: new Date(),
        outcome: "FAILED",
        outcomeMessage: String(e?.message ?? e ?? "Unknown error").slice(0, 500),
      },
    });

    return new Response("error", { status: 200 });
  } finally {
    const ms = Date.now() - started.getTime();
    if (ms > 4000) console.warn(`Webhook ${topic} (${webhookId}) took ${ms}ms`);
  }
};

async function ensureWebhookEventRow(args: { shop: string; webhookId: string; topic: string; resourceId: string }) {
  try {
    await db.webhookEvent.create({
      data: {
        shop: args.shop,
        webhookId: args.webhookId,
        topic: args.topic,
        resourceId: args.resourceId || "unknown",
        receivedAt: new Date(),
        outcome: "RECEIVED",
      },
    });
    return true;
  } catch {
    return false;
  }
}

function extractResourceId(topic: string, payload: any): string {
  switch (topic) {
    case "orders/paid":
    case "orders/cancelled":
      return String(payload?.id ?? payload?.order_id ?? "unknown");
    case "refunds/create":
      return String(payload?.id ?? "unknown");
    default:
      return String(payload?.id ?? "unknown");
  }
}

async function handlePrivacyWebhook(shop: string, topic: string, payload: any): Promise<HandleResult> {
  await db.privacyEvent.create({
    data: { shop, topic, payloadJson: JSON.stringify(payload ?? {}), receivedAt: new Date() } as any,
  });
  return { outcome: "PROCESSED", message: "Stored privacy event" };
}

/* ---------------- Orders / Paid ---------------- */

async function handleOrdersPaid(args: { shop: string; payload: any; admin: any }): Promise<HandleResult> {
  const { shop, payload, admin } = args;
  const settings = await getShopSettings(shop);

  const orderId = String(payload?.id ?? "");
  const orderName = String(payload?.name ?? orderId);
  const customerId = payload?.customer?.id ? String(payload.customer.id) : null;

  if (!orderId) return { outcome: "SKIPPED", message: "Missing order id" };
  if (!customerId) return { outcome: "SKIPPED", message: `Order ${orderName} has no customer` };

  const consumedCount = await consumeRedemptionsFromOrder(shop, customerId, orderId, payload);

  const existing = await db.orderPointsSnapshot.findUnique({
    where: { shop_orderId: { shop, orderId } },
    select: { pointsAwarded: true },
  });
  if (existing) {
    return { outcome: "SKIPPED", message: `Order ${orderName}: already snapshotted. Consumed=${consumedCount}` };
  }

  const productIds = collectProductIdsFromOrder(payload);
  const productTagsMap = productIds.length ? await fetchProductTagsMap(admin, productIds) : new Map();

  const eligibleNetCents = computeEligibleNetMerchCents(
    payload,
    productTagsMap,
    settings.includeProductTags,
    settings.excludeProductTags,
  );

  const eligibleDollarUnits = Math.floor(eligibleNetCents / 100);
  const pointsEarned = eligibleDollarUnits * settings.earnRate;

  await db.$transaction(async (tx) => {
    await tx.orderPointsSnapshot.create({
      data: {
        shop,
        orderId,
        orderName,
        customerId,
        eligibleNetMerchandise: eligibleNetCents,
        pointsAwarded: Math.max(0, pointsEarned),
        pointsReversedToDate: 0,
        paidAt: new Date(),
        discountCodesJson: payload?.discount_codes ? payload.discount_codes : null,
      } as any,
    });

    if (pointsEarned > 0) {
      await tx.pointsLedger.create({
        data: {
          shop,
          customerId,
          type: LedgerType.EARN,
          delta: pointsEarned,
          source: "ORDER",
          sourceId: orderId,
          description: `Earned ${pointsEarned} point(s) from order ${orderName}.`,
        },
      });

      await applyBalanceDelta(tx, shop, customerId, pointsEarned, { incEarned: pointsEarned });
    }
  });

  return {
    outcome: pointsEarned > 0 ? "PROCESSED" : "SKIPPED",
    message: `Order ${orderName}: points=${pointsEarned}. Consumed=${consumedCount}`,
  };
}

async function consumeRedemptionsFromOrder(shop: string, customerId: string, orderId: string, payload: any) {
  const codes = (payload?.discount_codes ?? [])
    .map((d: any) => (typeof d === "string" ? d : d?.code))
    .filter(Boolean)
    .map((c: string) => String(c).trim().toUpperCase());

  if (!codes.length) return 0;

  let consumed = 0;
  const now = new Date();

  for (const code of codes) {
    if (!code.startsWith("LCR")) continue;

    const updated = await db.redemption.updateMany({
      where: { shop, customerId, code, status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] } },
      data: { status: RedemptionStatus.CONSUMED, appliedAt: now, consumedAt: now, consumedOrderId: orderId },
    });

    consumed += updated.count;
  }
  return consumed;
}

function collectProductIdsFromOrder(orderPayload: any) {
  const ids = new Set<string>();
  for (const li of orderPayload?.line_items ?? []) {
    if (li?.product_id) ids.add(String(li.product_id));
  }
  return Array.from(ids);
}

async function fetchProductTagsMap(admin: any, numericProductIds: string[]) {
  const gids = numericProductIds.map((id) => `gid://shopify/Product/${id}`);

  const query = `#graphql
    query ProductTags($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product { id tags }
      }
    }
  `;

  const resp = await admin.graphql(query, { variables: { ids: gids } });
  const data = await resp.json();

  const map = new Map<string, string[]>();
  for (const node of data?.data?.nodes ?? []) {
    const numeric = String(node?.id ?? "").replace("gid://shopify/Product/", "");
    if (numeric) map.set(numeric, (node?.tags ?? []).map((t: any) => String(t)));
  }
  return map;
}

function computeEligibleNetMerchCents(orderPayload: any, tagMap: Map<string, string[]>, includeTags: any, excludeTags: any) {
  const include = normalizeTags(includeTags);
  const exclude = normalizeTags(excludeTags);

  let total = 0;
  for (const li of orderPayload?.line_items ?? []) {
    const qty = Number(li?.quantity ?? 0);
    const unitPrice = Number(li?.price ?? 0);
    const gross = Math.round(unitPrice * qty * 100);
    const discount = Math.round(Number(li?.total_discount ?? 0) * 100);
    const net = Math.max(0, gross - discount);

    const pid = li?.product_id ? String(li.product_id) : null;
    const tags = pid ? tagMap.get(pid) ?? [] : [];
    if (!isProductEligible(tags, include, exclude)) continue;

    total += net;
  }
  return Math.max(0, total);
}

function normalizeTags(tags: any) {
  return new Set((tags ?? []).map((t: any) => String(t).trim().toLowerCase()).filter(Boolean));
}
function isProductEligible(productTags: string[], include: Set<string>, exclude: Set<string>) {
  const tags = new Set(productTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  for (const ex of exclude) if (tags.has(ex)) return false;
  if (include.size === 0) return true;
  for (const inc of include) if (tags.has(inc)) return true;
  return false;
}

/* ---------------- Refunds / Create ---------------- */

async function handleRefundCreate(args: { shop: string; payload: any; admin: any }): Promise<HandleResult> {
  const { shop, payload, admin } = args;
  const settings = await getShopSettings(shop);

  const refundId = String(payload?.id ?? "");
  const orderId = String(payload?.order_id ?? "");
  const customerId = payload?.order?.customer?.id ? String(payload.order.customer.id) : null;

  if (!refundId || !orderId || !customerId) {
    return { outcome: "SKIPPED", message: "Missing refund/order/customer ids" };
  }

  const snapshot = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } } });
  if (!snapshot || snapshot.pointsAwarded <= 0) return { outcome: "SKIPPED", message: "No awarded points" };

  const remaining = Math.max(0, snapshot.pointsAwarded - snapshot.pointsReversedToDate);
  if (remaining <= 0) return { outcome: "SKIPPED", message: "Nothing to reverse" };

  const already = await db.pointsLedger.findFirst({
    where: { shop, type: LedgerType.REVERSAL, source: "REFUND", sourceId: refundId },
  });
  if (already) return { outcome: "SKIPPED", message: "Refund already processed" };

  const refundLines = payload?.refund_line_items ?? [];
  const productIds = new Set<string>();
  for (const rli of refundLines) if (rli?.line_item?.product_id) productIds.add(String(rli.line_item.product_id));
  const tagMap = productIds.size ? await fetchProductTagsMap(admin, Array.from(productIds)) : new Map();

  const eligibleRefundCents = computeEligibleRefundCents(refundLines, tagMap, settings.includeProductTags, settings.excludeProductTags);
  if (eligibleRefundCents <= 0) return { outcome: "SKIPPED", message: "No eligible refund cents" };

  const baseUnits = Math.floor(snapshot.eligibleNetMerchandise / 100);
  const refundUnits = Math.floor(eligibleRefundCents / 100);
  const perDollar = baseUnits > 0 ? snapshot.pointsAwarded / baseUnits : 0;
  const computed = Math.floor(refundUnits * perDollar + 1e-9);
  const pointsToReverse = Math.min(remaining, Math.max(0, computed));

  if (pointsToReverse <= 0) return { outcome: "SKIPPED", message: "Computed 0 points to reverse" };

  await db.$transaction(async (tx) => {
    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: LedgerType.REVERSAL,
        delta: -pointsToReverse,
        source: "REFUND",
        sourceId: refundId,
        description: `Reversed ${pointsToReverse} point(s) due to refund ${refundId}.`,
      },
    });

    await applyBalanceDelta(tx, shop, customerId, -pointsToReverse, {});
    await tx.orderPointsSnapshot.update({
      where: { shop_orderId: { shop, orderId } },
      data: { pointsReversedToDate: { increment: pointsToReverse } },
    });
  });

  return { outcome: "PROCESSED", message: `Refund ${refundId}: reversed ${pointsToReverse}` };
}

function computeEligibleRefundCents(refundLineItems: any[], tagMap: Map<string, string[]>, includeTags: any, excludeTags: any) {
  const include = normalizeTags(includeTags);
  const exclude = normalizeTags(excludeTags);

  let total = 0;
  for (const rli of refundLineItems ?? []) {
    const li = rli?.line_item;
    if (!li) continue;

    const refundedQty = Number(rli?.quantity ?? 0);
    const originalQty = Number(li?.quantity ?? refundedQty);
    const unitPrice = Number(li?.price ?? 0);

    const gross = Math.round(unitPrice * refundedQty * 100);
    const totalDiscount = Math.round(Number(li?.total_discount ?? 0) * 100);
    const discountPerUnit = originalQty > 0 ? totalDiscount / originalQty : 0;
    const discountForRefund = Math.round(discountPerUnit * refundedQty);
    const net = Math.max(0, gross - discountForRefund);

    const pid = li?.product_id ? String(li.product_id) : null;
    const tags = pid ? tagMap.get(pid) ?? [] : [];
    if (!isProductEligible(tags, include, exclude)) continue;

    total += net;
  }
  return Math.max(0, total);
}

/* ---------------- Orders / Cancelled ---------------- */

async function handleOrdersCancelled(args: { shop: string; payload: any }): Promise<HandleResult> {
  const { shop, payload } = args;

  const orderId = String(payload?.id ?? "");
  const customerId = payload?.customer?.id ? String(payload.customer.id) : null;
  if (!orderId || !customerId) return { outcome: "SKIPPED", message: "Missing order/customer" };

  const snapshot = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } } });
  if (!snapshot || snapshot.pointsAwarded <= 0) return { outcome: "SKIPPED", message: "No awarded points" };

  const remaining = Math.max(0, snapshot.pointsAwarded - snapshot.pointsReversedToDate);
  if (remaining <= 0) return { outcome: "SKIPPED", message: "Nothing to reverse" };

  const already = await db.pointsLedger.findFirst({
    where: { shop, type: LedgerType.REVERSAL, source: "CANCEL", sourceId: orderId },
  });
  if (already) return { outcome: "SKIPPED", message: "Cancel already processed" };

  await db.$transaction(async (tx) => {
    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: LedgerType.REVERSAL,
        delta: -remaining,
        source: "CANCEL",
        sourceId: orderId,
        description: `Reversed ${remaining} point(s) due to order cancellation.`,
      },
    });

    await applyBalanceDelta(tx, shop, customerId, -remaining, {});
    await tx.orderPointsSnapshot.update({
      where: { shop_orderId: { shop, orderId } },
      data: { pointsReversedToDate: snapshot.pointsAwarded, cancelledAt: new Date() } as any,
    });
  });

  return { outcome: "PROCESSED", message: `Order ${orderId}: reversed ${remaining} on cancel` };
}

/* ---------------- Shared balance updater ---------------- */

async function applyBalanceDelta(tx: any, shop: string, customerId: string, delta: number, opts: any) {
  const now = new Date();

  const existing = await tx.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
    select: { balance: true },
  });

  if (!existing) {
    await tx.customerPointsBalance.create({
      data: {
        shop,
        customerId,
        balance: Math.max(0, delta),
        lifetimeEarned: opts.incEarned ?? 0,
        lifetimeRedeemed: opts.incRedeemed ?? 0,
        lastActivityAt: now,
        expiredAt: null,
      },
    });
    return;
  }

  await tx.customerPointsBalance.update({
    where: { shop_customerId: { shop, customerId } },
    data: {
      balance: Math.max(0, existing.balance + delta),
      ...(opts.incEarned ? { lifetimeEarned: { increment: opts.incEarned } } : {}),
      ...(opts.incRedeemed ? { lifetimeRedeemed: { increment: opts.incRedeemed } } : {}),
      lastActivityAt: now,
      expiredAt: null,
    },
  });
}
