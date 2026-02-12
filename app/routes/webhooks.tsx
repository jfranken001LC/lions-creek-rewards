import { ActionFunctionArgs } from "@shopify/shopify-app-react-router/server";
import { LedgerType, WebhookEventOutcome } from "@prisma/client";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getShopSettings } from "../lib/shopSettings.server";

/**
 * Lions Creek Rewards — Webhook Receiver
 *
 * Handles (FR-4.7):
 * - orders/paid         => award points
 * - refunds/create      => proportional reversal (clamped; supports multiple refunds)
 * - orders/cancelled    => reverse remaining points
 * - compliance topics   => customers/data_request, customers/redact, shop/redact
 *
 * Dedupe:
 * - WebhookEvent.webhookId unique
 * - PointsLedger unique indexes (ledger_dedupe, ledger_refund_dedupe)
 */

function normalizeShopFromDest(dest: string): string {
  return String(dest || "").replace(/^https?:\/\//i, "").trim();
}

function normalizeTopic(topic: string): string {
  const t = String(topic || "").trim();
  if (!t) return t;
  // If already app-specific format:
  if (t.includes("/")) return t.toLowerCase();
  // Convert ORDERS_PAID -> orders/paid
  return t.toLowerCase().replace(/_/g, "/");
}

function toGid(kind: "Product" | "Customer", id: string | number): string {
  const n = String(id ?? "").trim();
  if (n.startsWith("gid://")) return n;
  return `gid://shopify/${kind}/${n}`;
}

function parseCustomerIdFromPayload(payload: any): string | null {
  const raw =
    payload?.customer?.id ??
    payload?.order?.customer?.id ??
    payload?.customer_id ??
    payload?.customerId ??
    null;

  if (!raw) return null;

  const s = String(raw);
  const m = s.match(/Customer\/(\d+)$/);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;

  // last resort: if it's a gid but not matching, keep as-is
  return s;
}

function parseOrderId(payload: any): string | null {
  const raw = payload?.id ?? payload?.order_id ?? payload?.order?.id ?? null;
  if (raw == null) return null;
  const s = String(raw);
  const m = s.match(/Order\/(\d+)$/);
  if (m) return m[1];
  return /^\d+$/.test(s) ? s : s;
}

function parseRefundId(payload: any): string | null {
  const raw = payload?.id ?? payload?.refund?.id ?? null;
  if (raw == null) return null;
  const s = String(raw);
  const m = s.match(/Refund\/(\d+)$/);
  if (m) return m[1];
  return /^\d+$/.test(s) ? s : s;
}

function toNumber(x: any): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

async function fetchProductTagsMap(admin: any, productNumericIds: Array<string | number>) {
  const ids = productNumericIds
    .map((id) => String(id))
    .filter((id) => /^\d+$/.test(id))
    .map((id) => toGid("Product", id));

  const map = new Map<string, string[]>();
  if (!ids.length) return map;

  const query = `#graphql
    query ProductTags($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product { id tags }
      }
    }`;

  const resp = await admin.graphql(query, { variables: { ids } });
  const json = await resp.json();

  const nodes = json?.data?.nodes ?? [];
  for (const node of nodes) {
    if (node?.id && Array.isArray(node?.tags)) {
      const m = String(node.id).match(/Product\/(\d+)$/);
      if (m) map.set(m[1], node.tags.map((t: any) => String(t)));
    }
  }
  return map;
}

function isLineEligibleByTags(
  productTags: string[],
  includeTags: string[],
  excludeTags: string[],
): boolean {
  const tagsLower = new Set(productTags.map((t) => t.toLowerCase()));
  const excludes = excludeTags.map((t) => t.toLowerCase()).filter(Boolean);
  for (const ex of excludes) {
    if (tagsLower.has(ex)) return false;
  }
  const includes = includeTags.map((t) => t.toLowerCase()).filter(Boolean);
  if (!includes.length) return true; // no include filter => eligible (unless excluded)
  return includes.some((inc) => tagsLower.has(inc));
}

function computeEligibleNetMerchandiseFromOrder(
  payload: any,
  productTagsMap: Map<string, string[]>,
  includeProductTags: string[],
  excludeProductTags: string[],
): number {
  const lines = Array.isArray(payload?.line_items) ? payload.line_items : [];
  let eligible = 0;

  for (const li of lines) {
    if (li?.gift_card === true) continue;

    const qty = Math.max(0, Math.floor(toNumber(li?.quantity)));
    const price = toNumber(li?.price);
    const totalDiscount = toNumber(li?.total_discount);
    const lineNet = Math.max(0, price * qty - totalDiscount);

    const productId = li?.product_id != null ? String(li.product_id) : null;
    if (productId && productTagsMap.size) {
      const tags = productTagsMap.get(productId) ?? [];
      if (!isLineEligibleByTags(tags, includeProductTags, excludeProductTags)) continue;
    }

    eligible += lineNet;
  }

  return Math.max(0, eligible);
}

function computeEligibleRefundNet(
  refundPayload: any,
  productTagsMap: Map<string, string[]>,
  includeProductTags: string[],
  excludeProductTags: string[],
): number {
  const items = Array.isArray(refundPayload?.refund_line_items)
    ? refundPayload.refund_line_items
    : [];

  let eligible = 0;

  for (const rli of items) {
    const li = rli?.line_item ?? null;

    // Prefer line_item.product_id for tag checks
    const productId =
      li?.product_id != null ? String(li.product_id) : rli?.product_id != null ? String(rli.product_id) : null;

    if (productId && productTagsMap.size) {
      const tags = productTagsMap.get(productId) ?? [];
      if (!isLineEligibleByTags(tags, includeProductTags, excludeProductTags)) continue;
    }

    // Subtotal is the net refunded amount for that line (pre-tax/shipping)
    const subtotal =
      rli?.subtotal != null ? toNumber(rli.subtotal) : rli?.subtotal_set?.shop_money?.amount != null ? toNumber(rli.subtotal_set.shop_money.amount) : 0;

    eligible += Math.max(0, subtotal);
  }

  return Math.max(0, eligible);
}

async function applyLedgerDelta(params: {
  shop: string;
  customerId: string;
  type: LedgerType;
  delta: number; // + for earn, - for redeem/reversal/expiry
  source: string;
  sourceId: string;
  description: string;
  now?: Date;
}) {
  const { shop, customerId, type, delta, source, sourceId, description } = params;
  const now = params.now ?? new Date();

  // Upsert balance row
  const bal = await db.customerPointsBalance.upsert({
    where: { shop_customerId: { shop, customerId } },
    create: {
      shop,
      customerId,
      pointsBalance: Math.max(0, delta),
      pointsLifetimeEarned: delta > 0 && type === LedgerType.EARN ? delta : 0,
      pointsLifetimeRedeemed: delta < 0 && type === LedgerType.REDEEM ? Math.abs(delta) : 0,
      pointsLastActivityAt: now,
    },
    update: {
      pointsBalance: { increment: delta },
      pointsLifetimeEarned:
        delta > 0 && type === LedgerType.EARN ? { increment: delta } : undefined,
      pointsLifetimeRedeemed:
        delta < 0 && type === LedgerType.REDEEM ? { increment: Math.abs(delta) } : undefined,
      pointsLastActivityAt: now,
    },
  });

  // Clamp negative balances back to zero (never allow negative customer balances)
  if (bal.pointsBalance < 0) {
    await db.customerPointsBalance.update({
      where: { shop_customerId: { shop, customerId } },
      data: { pointsBalance: 0 },
    });
  }

  // Insert ledger (unique indexes enforce idempotency across same source/sourceId)
  await db.pointsLedger.create({
    data: {
      shop,
      customerId,
      type,
      delta,
      source,
      sourceId,
      description,
      createdAt: now,
    },
  });
}

async function handleOrdersPaid(ctx: {
  shop: string;
  admin: any;
  payload: any;
}) {
  const { shop, admin, payload } = ctx;

  const orderId = parseOrderId(payload);
  const orderName = payload?.name ? String(payload.name) : orderId ? `#${orderId}` : "(order)";
  const customerId = parseCustomerIdFromPayload(payload);

  if (!orderId || !customerId) {
    return { outcome: WebhookEventOutcome.SKIPPED, code: "missing_ids", message: "Missing orderId or customerId." };
  }

  const settings = await getShopSettings(shop);

  const productIds = (Array.isArray(payload?.line_items) ? payload.line_items : [])
    .map((li: any) => li?.product_id)
    .filter((id: any) => id != null);

  const tagsMap = await fetchProductTagsMap(admin, productIds);

  const eligibleNet = computeEligibleNetMerchandiseFromOrder(
    payload,
    tagsMap,
    settings.includeProductTags,
    settings.excludeProductTags,
  );

  const eligibleDollars = Math.floor(eligibleNet);
  const pointsAwarded = Math.max(0, eligibleDollars * settings.earnRate);

  // Snapshot always created/updated (idempotent by unique shop+orderId)
  const snapshotExisting = await db.orderPointsSnapshot.findUnique({
    where: { shop_orderId: { shop, orderId } },
  });

  if (snapshotExisting && snapshotExisting.pointsAwarded > 0) {
    return { outcome: WebhookEventOutcome.SKIPPED, code: "already_awarded", message: `Order ${orderName} already awarded.` };
  }

  await db.$transaction(async (tx) => {
    await tx.orderPointsSnapshot.upsert({
      where: { shop_orderId: { shop, orderId } },
      create: {
        shop,
        orderId,
        orderName,
        customerId,
        eligibleNetMerchandise: eligibleNet,
        pointsAwarded,
        pointsReversedToDate: 0,
        discountCodesJson: Array.isArray(payload?.discount_codes)
          ? JSON.stringify(payload.discount_codes)
          : payload?.discount_codes
            ? JSON.stringify(payload.discount_codes)
            : null,
      },
      update: {
        orderName,
        customerId,
        eligibleNetMerchandise: eligibleNet,
        pointsAwarded,
      },
    });

    if (pointsAwarded > 0) {
      // Use unique ledger_dedupe: (shop, customerId, type, source, sourceId)
      await tx.pointsLedger.create({
        data: {
          shop,
          customerId,
          type: LedgerType.EARN,
          delta: pointsAwarded,
          source: "ORDER",
          sourceId: orderId,
          description: `Earned ${pointsAwarded} points on order ${orderName}`,
        },
      });

      await tx.customerPointsBalance.upsert({
        where: { shop_customerId: { shop, customerId } },
        create: {
          shop,
          customerId,
          pointsBalance: pointsAwarded,
          pointsLifetimeEarned: pointsAwarded,
          pointsLifetimeRedeemed: 0,
          pointsLastActivityAt: new Date(),
        },
        update: {
          pointsBalance: { increment: pointsAwarded },
          pointsLifetimeEarned: { increment: pointsAwarded },
          pointsLastActivityAt: new Date(),
        },
      });
    }
  });

  return { outcome: WebhookEventOutcome.PROCESSED, code: "ok", message: `Awarded ${pointsAwarded} on ${orderName}.` };
}

async function handleRefundsCreate(ctx: {
  shop: string;
  admin: any;
  payload: any;
}) {
  const { shop, admin } = ctx;

  // refunds/create payload is typically a Refund object
  const refund = ctx.payload?.refund ?? ctx.payload;
  const refundId = parseRefundId(refund);
  const orderId = parseOrderId(refund);

  if (!refundId || !orderId) {
    return { outcome: WebhookEventOutcome.SKIPPED, code: "missing_ids", message: "Missing refundId or orderId." };
  }

  const snapshot = await db.orderPointsSnapshot.findUnique({
    where: { shop_orderId: { shop, orderId } },
  });

  if (!snapshot || snapshot.pointsAwarded <= 0 || snapshot.eligibleNetMerchandise <= 0) {
    return { outcome: WebhookEventOutcome.SKIPPED, code: "no_snapshot", message: `No snapshot/points for order ${orderId}.` };
  }

  const customerId = snapshot.customerId;

  const settings = await getShopSettings(shop);

  const productIds = (Array.isArray(refund?.refund_line_items) ? refund.refund_line_items : [])
    .map((rli: any) => rli?.line_item?.product_id ?? rli?.product_id)
    .filter((id: any) => id != null);

  const tagsMap = await fetchProductTagsMap(admin, productIds);

  const refundedEligibleNet = computeEligibleRefundNet(
    refund,
    tagsMap,
    settings.includeProductTags,
    settings.excludeProductTags,
  );

  if (refundedEligibleNet <= 0) {
    return { outcome: WebhookEventOutcome.SKIPPED, code: "no_eligible_refund", message: "Refund had no eligible net to reverse." };
  }

  const remaining = Math.max(0, snapshot.pointsAwarded - snapshot.pointsReversedToDate);
  if (remaining <= 0) {
    return { outcome: WebhookEventOutcome.SKIPPED, code: "already_reversed", message: "All points already reversed." };
  }

  // Proportional reversal for this event (clamped)
  const raw = Math.floor((refundedEligibleNet / snapshot.eligibleNetMerchandise) * snapshot.pointsAwarded);
  const pointsToReverse = Math.max(0, Math.min(remaining, raw));

  if (pointsToReverse <= 0) {
    return { outcome: WebhookEventOutcome.SKIPPED, code: "rounds_to_zero", message: "Proportional reversal rounded to 0 after clamp." };
  }

  await db.$transaction(async (tx) => {
    // ledger_refund_dedupe: (shop, customerId, type, sourceId) => use refundId
    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: LedgerType.REVERSAL,
        delta: -pointsToReverse,
        source: "REFUND",
        sourceId: String(refundId),
        description: `Reversed ${pointsToReverse} points due to refund on order ${snapshot.orderName ?? orderId}`,
      },
    });

    const bal = await tx.customerPointsBalance.findUnique({
      where: { shop_customerId: { shop, customerId } },
    });

    const current = bal?.pointsBalance ?? 0;
    const next = Math.max(0, current - pointsToReverse);

    await tx.customerPointsBalance.upsert({
      where: { shop_customerId: { shop, customerId } },
      create: {
        shop,
        customerId,
        pointsBalance: next,
        pointsLifetimeEarned: 0,
        pointsLifetimeRedeemed: 0,
        pointsLastActivityAt: new Date(),
      },
      update: {
        pointsBalance: next,
        pointsLastActivityAt: new Date(),
      },
    });

    await tx.orderPointsSnapshot.update({
      where: { shop_orderId: { shop, orderId } },
      data: { pointsReversedToDate: { increment: pointsToReverse } },
    });
  });

  return {
    outcome: WebhookEventOutcome.PROCESSED,
    code: "ok",
    message: `Reversed ${pointsToReverse} points (refund ${refundId}, order ${orderId}).`,
  };
}

async function handleOrdersCancelled(ctx: { shop: string; payload: any }) {
  const { shop, payload } = ctx;

  const orderId = parseOrderId(payload);
  if (!orderId) {
    return { outcome: WebhookEventOutcome.SKIPPED, code: "missing_order", message: "Missing orderId." };
  }

  const snapshot = await db.orderPointsSnapshot.findUnique({
    where: { shop_orderId: { shop, orderId } },
  });

  if (!snapshot || snapshot.pointsAwarded <= 0) {
    return { outcome: WebhookEventOutcome.SKIPPED, code: "no_snapshot", message: `No snapshot/points for order ${orderId}.` };
  }

  const remaining = Math.max(0, snapshot.pointsAwarded - snapshot.pointsReversedToDate);
  if (remaining <= 0) {
    return { outcome: WebhookEventOutcome.SKIPPED, code: "already_reversed", message: "All points already reversed." };
  }

  await db.$transaction(async (tx) => {
    await tx.pointsLedger.create({
      data: {
        shop,
        customerId: snapshot.customerId,
        type: LedgerType.REVERSAL,
        delta: -remaining,
        source: "ORDER_CANCEL",
        sourceId: orderId,
        description: `Reversed ${remaining} points due to order cancellation (${snapshot.orderName ?? orderId})`,
      },
    });

    const bal = await tx.customerPointsBalance.findUnique({
      where: { shop_customerId: { shop, customerId: snapshot.customerId } },
    });

    const current = bal?.pointsBalance ?? 0;
    const next = Math.max(0, current - remaining);

    await tx.customerPointsBalance.upsert({
      where: { shop_customerId: { shop, customerId: snapshot.customerId } },
      create: {
        shop,
        customerId: snapshot.customerId,
        pointsBalance: next,
        pointsLifetimeEarned: 0,
        pointsLifetimeRedeemed: 0,
        pointsLastActivityAt: new Date(),
      },
      update: {
        pointsBalance: next,
        pointsLastActivityAt: new Date(),
      },
    });

    await tx.orderPointsSnapshot.update({
      where: { shop_orderId: { shop, orderId } },
      data: { pointsReversedToDate: { increment: remaining } },
    });
  });

  return {
    outcome: WebhookEventOutcome.PROCESSED,
    code: "ok",
    message: `Reversed remaining ${remaining} points for cancelled order ${orderId}.`,
  };
}

async function handleCustomersRedact(shop: string, payload: any) {
  const customerId = parseCustomerIdFromPayload(payload);
  if (!customerId) {
    return { outcome: WebhookEventOutcome.SKIPPED, code: "missing_customer", message: "Missing customerId." };
  }

  await db.$transaction(async (tx) => {
    await tx.redemption.deleteMany({ where: { shop, customerId } });
    await tx.pointsLedger.deleteMany({ where: { shop, customerId } });
    await tx.orderPointsSnapshot.deleteMany({ where: { shop, customerId } });
    await tx.customerPointsBalance.deleteMany({ where: { shop, customerId } });
  });

  return { outcome: WebhookEventOutcome.PROCESSED, code: "ok", message: `Deleted loyalty data for customer ${customerId}.` };
}

async function handleShopRedact(shop: string) {
  await db.$transaction(async (tx) => {
    await tx.redemption.deleteMany({ where: { shop } });
    await tx.pointsLedger.deleteMany({ where: { shop } });
    await tx.orderPointsSnapshot.deleteMany({ where: { shop } });
    await tx.customerPointsBalance.deleteMany({ where: { shop } });
    await tx.shopSettings.deleteMany({ where: { shop } });
    await tx.webhookEvent.deleteMany({ where: { shop } });
    await tx.session.deleteMany({ where: { shop } });
  });

  return { outcome: WebhookEventOutcome.PROCESSED, code: "ok", message: `Deleted all app data for shop ${shop}.` };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const webhookAt = new Date();

  // Authenticate + parse payload using Shopify’s helpers (HMAC verified)
  const { topic, shop, webhookId, payload, admin } = await authenticate.webhook(request);
  const t = normalizeTopic(String(topic));
  const s = String(shop);

  // Dedupe by webhookId
  const wid = String(webhookId);
  const existing = await db.webhookEvent.findUnique({ where: { webhookId: wid } }).catch(() => null);
  if (existing) return new Response(null, { status: 200 });

  // Resource id (best-effort)
  const resourceId =
    (t.startsWith("orders/") ? parseOrderId(payload) : null) ??
    (t.startsWith("refunds/") ? parseRefundId(payload) : null) ??
    (t.startsWith("customers/") ? parseCustomerIdFromPayload(payload) : null) ??
    null;

  await db.webhookEvent.create({
    data: {
      webhookId: wid,
      shop: s,
      topic: t,
      resourceId: resourceId ? String(resourceId) : null,
      receivedAt: webhookAt,
      outcome: WebhookEventOutcome.RECEIVED,
    },
  });

  try {
    let result:
      | { outcome: WebhookEventOutcome; code: string; message: string }
      | null = null;

    switch (t) {
      case "orders/paid":
        result = await handleOrdersPaid({ shop: s, admin, payload });
        break;

      case "refunds/create":
        result = await handleRefundsCreate({ shop: s, admin, payload });
        break;

      case "orders/cancelled":
        result = await handleOrdersCancelled({ shop: s, payload });
        break;

      // Compliance topics:
      case "customers/data/request":
      case "customers/data_request":
        result = {
          outcome: WebhookEventOutcome.PROCESSED,
          code: "ok",
          message: "Data request received (no stored PII beyond IDs).",
        };
        break;

      case "customers/redact":
        result = await handleCustomersRedact(s, payload);
        break;

      case "shop/redact":
        result = await handleShopRedact(s);
        break;

      default:
        result = {
          outcome: WebhookEventOutcome.SKIPPED,
          code: "unhandled_topic",
          message: `Unhandled topic: ${t}`,
        };
        break;
    }

    await db.webhookEvent.update({
      where: { webhookId: wid },
      data: {
        outcome: result.outcome,
        outcomeCode: result.code,
        outcomeMessage: result.message,
      },
    });

    return new Response(null, { status: 200 });
  } catch (err: any) {
    const msg = typeof err?.message === "string" ? err.message : String(err);

    await db.webhookEvent.update({
      where: { webhookId: wid },
      data: {
        outcome: WebhookEventOutcome.FAILED,
        outcomeCode: "error",
        outcomeMessage: msg.slice(0, 4000),
      },
    });

    // Shopify expects 200 to stop retries only if processed; but for FAILED we still return 200
    // to avoid retry storms. You can change to 500 if you explicitly want retries.
    return new Response(null, { status: 200 });
  }
};
