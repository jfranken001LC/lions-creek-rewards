// app/routes/webhooks.tsx
import { type ActionFunctionArgs } from "react-router";
import { LedgerType, RedemptionStatus, WebhookOutcome } from "@prisma/client";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getShopSettings } from "../lib/shopSettings.server";
import { fetchCustomerTags, resolveEligibleCollectionGid, type AdminGraphql } from "../lib/shopifyQueries.server";

type HandleResult = { outcome: WebhookOutcome; message?: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const started = new Date();
  const { shop, topic, webhookId, payload, admin } = await authenticate.webhook(request);

  const resourceId = extractResourceId(topic, payload);

  // Deduplicate first. If we already have this webhookId for this shop, do nothing.
  const created = await ensureWebhookEventRow({ shop, webhookId, topic, resourceId, payload });
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

    // Shopify expects 200 for webhooks; we log outcome as FAILED in DB.
    return new Response("error", { status: 200 });
  } finally {
    const ms = Date.now() - started.getTime();
    if (ms > 4000) console.warn(`Webhook ${topic} (${webhookId}) took ${ms}ms`);
  }
};

async function ensureWebhookEventRow(args: {
  shop: string;
  webhookId: string;
  topic: string;
  resourceId: string;
  payload: any;
}) {
  try {
    await db.webhookEvent.create({
      data: {
        shop: args.shop,
        webhookId: args.webhookId,
        topic: args.topic,
        resourceId: args.resourceId || "unknown",
        receivedAt: new Date(),
        payload: args.payload ?? {},
        outcome: "RECEIVED",
      },
    });
    return true;
  } catch {
    // Unique violation => already received/processed
    return false;
  }
}

function extractResourceId(topic: string, payload: any): string {
  switch (topic) {
    case "orders/paid":
    case "orders/cancelled":
      return String(payload?.id ?? payload?.order_id ?? "unknown");
    case "refunds/create":
      return String(payload?.id ?? payload?.order_id ?? "unknown");
    default:
      return String(payload?.id ?? "unknown");
  }
}

async function handlePrivacyWebhook(shop: string, topic: string, payload: any): Promise<HandleResult> {
  await db.privacyEvent.create({
    data: { shop, topic, payloadJson: payload ?? {}, receivedAt: new Date() },
  });
  return { outcome: "PROCESSED", message: "Stored privacy event" };
}

/* ---------------- Shared helpers ---------------- */

function makeAdminGraphql(admin: any): AdminGraphql {
  return async (query: string, args?: { variables?: Record<string, any> }) => {
    return admin.graphql(query, args);
  };
}

async function adminGraphqlJson(adminGraphql: AdminGraphql, query: string, variables?: Record<string, any>): Promise<any> {
  const resp = await adminGraphql(query, { variables });
  const text = await resp.text().catch(() => "");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!resp.ok) {
    throw new Error(`Shopify GraphQL failed: ${resp.status} ${resp.statusText} ${text}`);
  }
  if (json?.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json?.data ?? null;
}

function normalizeTags(tags: any) {
  return new Set((tags ?? []).map((t: any) => String(t).trim().toLowerCase()).filter(Boolean));
}

function isProductEligibleByTags(productTags: string[], include: Set<string>, exclude: Set<string>) {
  const tags = new Set(productTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  for (const ex of exclude) if (tags.has(ex)) return false;
  if (include.size === 0) return true;
  for (const inc of include) if (tags.has(inc)) return true;
  return false;
}

function parseCustomerTagsFromPayload(payload: any): string[] | null {
  const raw = payload?.customer?.tags ?? payload?.order?.customer?.tags;
  if (Array.isArray(raw)) return raw.map((t) => String(t)).filter(Boolean);
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return [];
    return s
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return null;
}

function customerIsExcluded(customerTags: string[], excluded: string[]): boolean {
  if (!excluded?.length) return false;
  const have = new Set(customerTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  return excluded.some((t) => have.has(String(t).trim().toLowerCase()));
}

type ProductEligibility = { tags: string[]; inEligibleCollection: boolean };

async function fetchProductEligibilityMap(args: {
  adminGraphql: AdminGraphql;
  numericProductIds: string[];
  eligibleCollectionHandle: string;
  eligibleCollectionGid: string | null;
}): Promise<Map<string, ProductEligibility>> {
  const { adminGraphql, numericProductIds, eligibleCollectionHandle, eligibleCollectionGid } = args;

  const gids = numericProductIds.map((id) => `gid://shopify/Product/${id}`);

  // Fast path if we have a cached collection GID: use Product.inCollection(id:)
  if (eligibleCollectionGid) {
    const query = `#graphql
      query ProductEligibility($ids: [ID!]!, $collectionId: ID!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            tags
            inCollection(id: $collectionId)
          }
        }
      }
    `;

    try {
      const data = await adminGraphqlJson(adminGraphql, query, { ids: gids, collectionId: eligibleCollectionGid });

      const map = new Map<string, ProductEligibility>();
      for (const node of data?.nodes ?? []) {
        const numeric = String(node?.id ?? "").replace("gid://shopify/Product/", "");
        if (!numeric) continue;
        map.set(numeric, {
          tags: (node?.tags ?? []).map((t: any) => String(t)),
          inEligibleCollection: Boolean(node?.inCollection),
        });
      }
      return map;
    } catch (e) {
      // If inCollection isn't available / errors, fall back to collections-by-handle below.
      console.warn("ProductEligibility inCollection query failed; falling back to collections list:", e);
    }
  }

  // Fallback: check collection membership by handle via Product.collections
  const query = `#graphql
    query ProductEligibilityByHandle($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          tags
          collections(first: 50) { nodes { handle } }
        }
      }
    }
  `;

  const data = await adminGraphqlJson(adminGraphql, query, { ids: gids });

  const handleLower = String(eligibleCollectionHandle || "").trim().toLowerCase();
  const map = new Map<string, ProductEligibility>();

  for (const node of data?.nodes ?? []) {
    const numeric = String(node?.id ?? "").replace("gid://shopify/Product/", "");
    if (!numeric) continue;

    const collections = (node?.collections?.nodes ?? []).map((c: any) => String(c?.handle ?? "").trim().toLowerCase());
    const inEligibleCollection = handleLower ? collections.includes(handleLower) : true;

    map.set(numeric, {
      tags: (node?.tags ?? []).map((t: any) => String(t)),
      inEligibleCollection,
    });
  }

  return map;
}

function collectProductIdsFromOrder(orderPayload: any) {
  const ids = new Set<string>();
  for (const li of orderPayload?.line_items ?? []) {
    if (li?.product_id) ids.add(String(li.product_id));
  }
  return Array.from(ids);
}

function computeEligibleNetMerchCents(args: {
  orderPayload: any;
  productEligibility: Map<string, ProductEligibility>;
  includeProductTags: string[];
  excludeProductTags: string[];
}): number {
  const include = normalizeTags(args.includeProductTags);
  const exclude = normalizeTags(args.excludeProductTags);

  let total = 0;

  for (const li of args.orderPayload?.line_items ?? []) {
    const qty = Number(li?.quantity ?? 0);
    const unitPrice = Number(li?.price ?? 0);

    // Shopify order webhook payload: `price` is per-unit price (typically pre-tax).
    const gross = Math.round(unitPrice * qty * 100);
    const discount = Math.round(Number(li?.total_discount ?? 0) * 100);
    const net = Math.max(0, gross - discount);

    const pid = li?.product_id ? String(li.product_id) : null;
    if (!pid) continue;

    const info = args.productEligibility.get(pid);
    if (!info?.inEligibleCollection) continue;
    if (!isProductEligibleByTags(info.tags, include, exclude)) continue;

    total += net;
  }

  return Math.max(0, total);
}

function computeEligibleRefundCents(args: {
  refundLineItems: any[];
  productEligibility: Map<string, ProductEligibility>;
  includeProductTags: string[];
  excludeProductTags: string[];
}): number {
  const include = normalizeTags(args.includeProductTags);
  const exclude = normalizeTags(args.excludeProductTags);

  let total = 0;

  for (const rli of args.refundLineItems ?? []) {
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
    if (!pid) continue;

    const info = args.productEligibility.get(pid);
    if (!info?.inEligibleCollection) continue;
    if (!isProductEligibleByTags(info.tags, include, exclude)) continue;

    total += net;
  }

  return Math.max(0, total);
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
    // Your redemption codes are generated with an "LCR" prefix.
    if (!code.startsWith("LCR")) continue;

    const updated = await db.redemption.updateMany({
      where: { shop, customerId, code, status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] } },
      data: { status: RedemptionStatus.CONSUMED, appliedAt: now, consumedAt: now, consumedOrderId: orderId },
    });

    consumed += updated.count;
  }

  return consumed;
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

  // Idempotency: only snapshot once per (shop, orderId)
  const existing = await db.orderPointsSnapshot.findUnique({
    where: { shop_orderId: { shop, orderId } },
    select: { pointsAwarded: true },
  });
  if (existing) {
    return { outcome: "SKIPPED", message: `Order ${orderName}: already snapshotted. Consumed=${consumedCount}` };
  }

  if (!admin) return { outcome: "FAILED", message: "Missing admin client in webhook context" };
  const adminGraphql = makeAdminGraphql(admin);

  // Excluded customer tags (block earning; redemption is already blocked in redemption.server.ts)
  let customerTags = parseCustomerTagsFromPayload(payload);
  if (customerTags == null) {
    try {
      customerTags = await fetchCustomerTags(adminGraphql, customerId);
    } catch {
      customerTags = [];
    }
  }
  const excluded = customerIsExcluded(customerTags, settings.excludedCustomerTags);

  // Best-effort: resolve/cache eligible collection GID. If it fails, we can still evaluate membership by handle.
  let eligibleCollectionGid: string | null = settings.eligibleCollectionGid;
  if (!eligibleCollectionGid) {
    try {
      eligibleCollectionGid = await resolveEligibleCollectionGid(adminGraphql, shop, settings);
    } catch {
      eligibleCollectionGid = null;
    }
  }

  let eligibleNetCents = 0;

  // Only compute eligibility if not excluded (keeps program rules strict and avoids extra API calls for excluded customers).
  if (!excluded) {
    const productIds = collectProductIdsFromOrder(payload);
    const productEligibility = productIds.length
      ? await fetchProductEligibilityMap({
          adminGraphql,
          numericProductIds: productIds,
          eligibleCollectionHandle: settings.eligibleCollectionHandle,
          eligibleCollectionGid,
        })
      : new Map<string, ProductEligibility>();

    eligibleNetCents = computeEligibleNetMerchCents({
      orderPayload: payload,
      productEligibility,
      includeProductTags: settings.includeProductTags,
      excludeProductTags: settings.excludeProductTags,
    });
  }

  const eligibleDollarUnits = Math.floor(eligibleNetCents / 100);
  const pointsEarned = excluded ? 0 : Math.max(0, eligibleDollarUnits * settings.earnRate);

  await db.$transaction(async (tx) => {
    await tx.orderPointsSnapshot.create({
      data: {
        shop,
        orderId,
        orderName,
        customerId,
        eligibleNetMerchandise: eligibleNetCents,
        pointsAwarded: pointsEarned,
        pointsReversedToDate: 0,
        paidAt: new Date(),
        discountCodesJson: payload?.discount_codes ? payload.discount_codes : null,
      },
    });

    // Always treat a paid order as "activity" for non-excluded customers (prevents inactivity expiry even if 0 points earned)
    if (!excluded) {
      await applyBalanceDelta(tx, shop, customerId, 0, {});
    }

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

  if (excluded) {
    return { outcome: "SKIPPED", message: `Order ${orderName}: customer excluded. Consumed=${consumedCount}` };
  }

  return {
    outcome: pointsEarned > 0 ? "PROCESSED" : "SKIPPED",
    message: `Order ${orderName}: eligibleNet=$${(eligibleNetCents / 100).toFixed(2)} points=${pointsEarned}. Consumed=${consumedCount}`,
  };
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

  if (!admin) return { outcome: "FAILED", message: "Missing admin client in webhook context" };
  const adminGraphql = makeAdminGraphql(admin);

  // Best-effort: resolve/cache eligible collection GID. If it fails, we can still evaluate membership by handle.
  let eligibleCollectionGid: string | null = settings.eligibleCollectionGid;
  if (!eligibleCollectionGid) {
    try {
      eligibleCollectionGid = await resolveEligibleCollectionGid(adminGraphql, shop, settings);
    } catch {
      eligibleCollectionGid = null;
    }
  }

  const refundLines = payload?.refund_line_items ?? [];
  const productIds = new Set<string>();
  for (const rli of refundLines) if (rli?.line_item?.product_id) productIds.add(String(rli.line_item.product_id));

  const productEligibility = productIds.size
    ? await fetchProductEligibilityMap({
        adminGraphql,
        numericProductIds: Array.from(productIds),
        eligibleCollectionHandle: settings.eligibleCollectionHandle,
        eligibleCollectionGid,
      })
    : new Map<string, ProductEligibility>();

  const eligibleRefundCents = computeEligibleRefundCents({
    refundLineItems: refundLines,
    productEligibility,
    includeProductTags: settings.includeProductTags,
    excludeProductTags: settings.excludeProductTags,
  });

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

  return {
    outcome: "PROCESSED",
    message: `Refund ${refundId}: eligibleRefund=$${(eligibleRefundCents / 100).toFixed(2)} reversed ${pointsToReverse}`,
  };
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
      data: { pointsReversedToDate: snapshot.pointsAwarded, cancelledAt: new Date() },
    });
  });

  return { outcome: "PROCESSED", message: `Order ${orderId}: reversed ${remaining} on cancel` };
}

/* ---------------- Shared balance updater ---------------- */

async function applyBalanceDelta(
  tx: any,
  shop: string,
  customerId: string,
  delta: number,
  opts: { incEarned?: number; incRedeemed?: number },
) {
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
