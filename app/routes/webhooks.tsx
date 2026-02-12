// app/routes/webhooks.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopSettings } from "../lib/shopSettings.server";
import { Prisma, WebhookOutcome } from "@prisma/client";

/**
 * Notes:
 * - Uses authenticate.webhook() for HMAC + payload parsing.
 * - Writes WebhookEvent + WebhookError per FR-6.1/6.2.
 * - Applies points using PointsLedger(source, sourceId) uniqueness constraints.
 */

export const loader = async (_args: LoaderFunctionArgs) => {
  return new Response("ok", { status: 200 });
};

function normalizeTopic(raw: unknown): string {
  const s = String(raw ?? "").trim();
  const lower = s.toLowerCase();
  if (lower.includes("/")) return lower;

  // Shopify libs sometimes surface topics as "ORDERS_PAID"
  if (lower.includes("_")) {
    const [a, ...rest] = lower.split("_");
    return `${a}/${rest.join("_")}`;
  }

  return lower;
}

function moneyToCents(amount: unknown): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function clampInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function isEligibleByTags(
  productTags: string[],
  includeTags: string[],
  excludeTags: string[],
): boolean {
  const tags = new Set(productTags.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const excludes = excludeTags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  for (const ex of excludes) {
    if (tags.has(ex)) return false;
  }

  const includes = includeTags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (includes.length === 0) return true;
  return includes.some((inc) => tags.has(inc));
}

async function getOfflineAccessToken(shop: string): Promise<string> {
  const s = await db.session.findFirst({
    where: { shop, isOnline: false },
    orderBy: { createdAt: "desc" },
    select: { accessToken: true },
  });

  if (!s?.accessToken) {
    throw new Error(`No offline access token found for shop ${shop}`);
  }
  return s.accessToken;
}

async function shopifyGraphql<T>(
  shop: string,
  query: string,
  variables: Record<string, any>,
): Promise<T> {
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
    const msg = json?.errors ? JSON.stringify(json.errors) : `HTTP ${resp.status}`;
    throw new Error(`GraphQL failed: ${msg}`);
  }
  return json.data as T;
}

async function upsertWebhookReceived(shop: string, webhookId: string, topic: string, resourceId: string) {
  try {
    await db.webhookEvent.create({
      data: {
        shop,
        webhookId,
        topic,
        resourceId,
        outcome: WebhookOutcome.RECEIVED,
        outcomeCode: null,
        outcomeMessage: null,
      },
    });
    return { isDuplicate: false };
  } catch (e: any) {
    // Duplicate delivery
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      await db.webhookEvent.update({
        where: { shop_webhookId: { shop, webhookId } },
        data: {
          outcome: WebhookOutcome.SKIPPED,
          outcomeCode: "DUPLICATE",
          outcomeMessage: "Duplicate webhook delivery (shop_webhookId unique).",
          processedAt: new Date(),
        },
      });
      return { isDuplicate: true };
    }
    throw e;
  }
}

async function markWebhookProcessed(shop: string, webhookId: string, outcome: WebhookOutcome, code: string | null, message: string | null) {
  await db.webhookEvent.update({
    where: { shop_webhookId: { shop, webhookId } },
    data: {
      outcome,
      outcomeCode: code,
      outcomeMessage: message,
      processedAt: new Date(),
    },
  });
}

async function logWebhookError(shop: string, topic: string, webhookId: string, payload: any, err: unknown) {
  const message =
    err instanceof Error ? `${err.name}: ${err.message}` : typeof err === "string" ? err : JSON.stringify(err);

  await db.webhookError.create({
    data: {
      shop,
      topic,
      webhookId,
      error: message,
      payloadJson: JSON.stringify(payload ?? {}),
    },
  });
}

async function handleCustomersRedact(shop: string, payload: any) {
  // Best-effort: remove customer-centric state (balance, redemptions, snapshots)
  // Keep PointsLedger only if merchant prefers; in absence of a config flag, we *delete* customer-linked ledger to be safe.
  const customerId =
    String(payload?.customer?.id ?? payload?.customer_id ?? payload?.customerId ?? "").trim();

  if (!customerId) return;

  await db.$transaction(async (tx) => {
    await tx.redemption.deleteMany({ where: { shop, customerId } });
    await tx.orderPointsSnapshot.deleteMany({ where: { shop, customerId } });
    await tx.customerPointsBalance.deleteMany({ where: { shop, customerId } });
    await tx.pointsLedger.deleteMany({ where: { shop, customerId } });
  });
}

async function handleShopRedact(shop: string) {
  await db.$transaction(async (tx) => {
    await tx.redemption.deleteMany({ where: { shop } });
    await tx.orderPointsSnapshot.deleteMany({ where: { shop } });
    await tx.customerPointsBalance.deleteMany({ where: { shop } });
    await tx.pointsLedger.deleteMany({ where: { shop } });
    await tx.webhookError.deleteMany({ where: { shop } });
    await tx.webhookEvent.deleteMany({ where: { shop } });
    await tx.privacyEvent.deleteMany({ where: { shop } });
    await tx.shopSettings.deleteMany({ where: { shop } });
    await tx.session.deleteMany({ where: { shop } });
    await tx.jobLock.deleteMany({ where: { shop } });
  });
}

async function applyPointsDelta(params: {
  shop: string;
  customerId: string;
  delta: number;
  ledgerType: "EARN" | "REVERSAL" | "EXPIRE" | "REDEEM" | "ADJUST";
  source: string;
  sourceId: string;
  description: string;
}) {
  const { shop, customerId, delta, ledgerType, source, sourceId, description } = params;

  await db.$transaction(async (tx) => {
    // Dedupe by ledger unique constraint
    const existing = await tx.pointsLedger.findFirst({
      where: { shop, customerId, type: ledgerType as any, source, sourceId },
      select: { id: true },
    });
    if (existing) return;

    // Ensure balance row exists
    const bal =
      (await tx.customerPointsBalance.findUnique({
        where: { shop_customerId: { shop, customerId } },
      })) ??
      (await tx.customerPointsBalance.create({
        data: {
          shop,
          customerId,
          balance: 0,
          lifetimeEarned: 0,
          lifetimeRedeemed: 0,
          lastActivityAt: null,
          expiredAt: null,
        },
      }));

    const requested = clampInt(delta);
    const next = Math.max(0, bal.balance + requested);
    const applied = next - bal.balance; // clamped delta actually applied

    if (applied === 0) return;

    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: ledgerType as any,
        delta: applied,
        source,
        sourceId,
        description,
      },
    });

    await tx.customerPointsBalance.update({
      where: { shop_customerId: { shop, customerId } },
      data: {
        balance: next,
        // only lifetimeEarned/lifetimeRedeemed updated for their natural flows;
        // webhooks use EARN/REVERSAL; redeem uses REDEEM; expiry uses EXPIRE.
        lifetimeEarned:
          ledgerType === "EARN" ? { increment: Math.max(0, applied) } : undefined,
        lifetimeRedeemed:
          ledgerType === "REDEEM" ? { increment: Math.max(0, -applied) } : undefined,
        lastActivityAt: new Date(),
      },
    });
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("ok", { status: 200 });

  // Authenticate + parse payload via Shopify framework
  let ctx: any;
  try {
    ctx = await authenticate.webhook(request);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const shop: string = ctx.shop;
  const webhookId: string = String(ctx.webhookId ?? "");
  const topicNorm = normalizeTopic(ctx.topic);
  const payload = typeof ctx.payload === "string" ? JSON.parse(ctx.payload) : ctx.payload;

  // Determine a resourceId for logging
  const resourceId =
    String(payload?.id ?? payload?.order_id ?? payload?.orderId ?? payload?.customer_id ?? payload?.shop_id ?? "unknown");

  // Create RECEIVED record (or mark duplicate)
  try {
    const r = await upsertWebhookReceived(shop, webhookId, topicNorm, resourceId);
    if (r.isDuplicate) return new Response("ok", { status: 200 });
  } catch (e) {
    // If we can't even log, still return 200 to avoid retry storms.
    return new Response("ok", { status: 200 });
  }

  try {
    // Compliance topics
    if (topicNorm === "customers/data_request" || topicNorm === "customers/redact" || topicNorm === "shop/redact") {
      await db.privacyEvent.create({
        data: {
          shop,
          topic: topicNorm,
          payloadJson: JSON.stringify(payload ?? {}),
        },
      });

      if (topicNorm === "customers/redact") await handleCustomersRedact(shop, payload);
      if (topicNorm === "shop/redact") await handleShopRedact(shop);

      await markWebhookProcessed(shop, webhookId, WebhookOutcome.PROCESSED, "COMPLIANCE_OK", null);
      return new Response("ok", { status: 200 });
    }

    // app/uninstalled: best-effort cleanup
    if (topicNorm === "app/uninstalled") {
      await db.session.deleteMany({ where: { shop } });
      await markWebhookProcessed(shop, webhookId, WebhookOutcome.PROCESSED, "UNINSTALLED_OK", null);
      return new Response("ok", { status: 200 });
    }

    // Loyalty topics
    const settings = await getShopSettings(shop);

    if (topicNorm === "orders/paid") {
      const orderId = String(payload?.id ?? "");
      const orderName = String(payload?.name ?? payload?.order_number ?? "");
      const currency = String(payload?.currency ?? "CAD");
      const customerId = String(payload?.customer?.id ?? payload?.customer_id ?? "").trim();

      if (!orderId || !customerId) {
        await markWebhookProcessed(shop, webhookId, WebhookOutcome.SKIPPED, "NO_CUSTOMER", "Guest checkout / no customerId.");
        return new Response("ok", { status: 200 });
      }

      // Customer exclusion based on tags (if present in payload)
      const customerTags = String(payload?.customer?.tags ?? "")
        .split(",")
        .map((t: string) => t.trim())
        .filter(Boolean);
      const excluded = new Set(settings.excludedCustomerTags.map((t) => t.trim().toLowerCase()).filter(Boolean));
      if (customerTags.some((t) => excluded.has(t.toLowerCase()))) {
        await markWebhookProcessed(shop, webhookId, WebhookOutcome.SKIPPED, "CUSTOMER_EXCLUDED", "Customer tag excludes earning.");
        return new Response("ok", { status: 200 });
      }

      // Gather product IDs from line items (REST webhook payload)
      const lineItems: any[] = Array.isArray(payload?.line_items) ? payload.line_items : [];
      const productIds = Array.from(
        new Set(
          lineItems
            .map((li) => li?.product_id)
            .filter((id) => id !== null && id !== undefined)
            .map((id) => String(id)),
        ),
      );

      // Pull tags for all products in one call
      let productTagsById = new Map<string, string[]>();
      if (productIds.length > 0) {
        const ids = productIds.map((id) => `gid://shopify/Product/${id}`);
        const query = `
          query ProductTags($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product { id tags }
            }
          }
        `;
        type Resp = { nodes: Array<{ id: string; tags: string[] } | null> };
        const data = await shopifyGraphql<Resp>(shop, query, { ids });
        for (const node of data.nodes) {
          if (!node?.id) continue;
          const legacyId = String(node.id).split("/").pop() ?? "";
          if (legacyId) productTagsById.set(legacyId, node.tags ?? []);
        }
      }

      // Compute eligible net merchandise (cents)
      let eligibleNetCents = 0;
      for (const li of lineItems) {
        const qty = clampInt(Number(li?.quantity ?? 0));
        if (qty <= 0) continue;

        const productId = li?.product_id != null ? String(li.product_id) : "";
        const tags = productId ? productTagsById.get(productId) ?? [] : [];

        const eligible = isEligibleByTags(tags, settings.includeProductTags, settings.excludeProductTags);
        if (!eligible) continue;

        const priceCents = moneyToCents(li?.price);
        const discountCents = moneyToCents(li?.total_discount ?? 0);
        const lineNet = priceCents * qty - discountCents;
        if (lineNet > 0) eligibleNetCents += lineNet;
      }

      const earnRate = clampInt(settings.earnRate ?? 1);
      const pointsEarned = Math.max(0, Math.floor((eligibleNetCents * earnRate) / 100));

      // Persist snapshot (cents stored in eligibleNetMerchandise)
      await db.orderPointsSnapshot.upsert({
        where: { shop_orderId: { shop, orderId } },
        create: {
          shop,
          orderId,
          orderName,
          customerId,
          eligibleNetMerchandise: eligibleNetCents,
          pointsAwarded: pointsEarned,
          pointsReversedToDate: 0,
          paidAt: payload?.processed_at ? new Date(payload.processed_at) : new Date(),
          cancelledAt: null,
          currency,
          discountCodesJson: payload?.discount_codes ? JSON.stringify(payload.discount_codes) : null,
        },
        update: {
          orderName,
          customerId,
          eligibleNetMerchandise: eligibleNetCents,
          pointsAwarded: pointsEarned,
          paidAt: payload?.processed_at ? new Date(payload.processed_at) : new Date(),
          currency,
          discountCodesJson: payload?.discount_codes ? JSON.stringify(payload.discount_codes) : null,
        },
      });

      if (pointsEarned <= 0) {
        await markWebhookProcessed(shop, webhookId, WebhookOutcome.PROCESSED, "NO_POINTS", "Eligible net merchandise produced 0 points.");
        return new Response("ok", { status: 200 });
      }

      await applyPointsDelta({
        shop,
        customerId,
        delta: pointsEarned,
        ledgerType: "EARN",
        source: "ORDER",
        sourceId: orderId,
        description: `Earned ${pointsEarned} points for order ${orderName || orderId}.`,
      });

      await markWebhookProcessed(shop, webhookId, WebhookOutcome.PROCESSED, "EARN_OK", null);
      return new Response("ok", { status: 200 });
    }

    if (topicNorm === "refunds/create") {
      const refundId = String(payload?.id ?? "");
      const orderId = String(payload?.order_id ?? "");
      if (!refundId || !orderId) {
        await markWebhookProcessed(shop, webhookId, WebhookOutcome.SKIPPED, "MISSING_IDS", "Missing refundId or orderId in payload.");
        return new Response("ok", { status: 200 });
      }

      const snapshot = await db.orderPointsSnapshot.findUnique({
        where: { shop_orderId: { shop, orderId } },
      });

      // If we have no snapshot, we cannot reliably reverse; skip (still logged)
      if (!snapshot?.customerId) {
        await markWebhookProcessed(shop, webhookId, WebhookOutcome.SKIPPED, "NO_SNAPSHOT", "No order snapshot found for refund reversal.");
        return new Response("ok", { status: 200 });
      }

      const remaining = Math.max(0, snapshot.pointsAwarded - snapshot.pointsReversedToDate);
      if (remaining <= 0) {
        await markWebhookProcessed(shop, webhookId, WebhookOutcome.SKIPPED, "NO_REMAINING", "No remaining points to reverse.");
        return new Response("ok", { status: 200 });
      }

      // Best-effort compute reversal amount from refund_line_items
      const refundLineItems: any[] = Array.isArray(payload?.refund_line_items) ? payload.refund_line_items : [];

      // Pull order line items w/ product tags to keep reversals tag-accurate
      const orderGid = `gid://shopify/Order/${orderId}`;
      const q = `
        query OrderForRefund($id: ID!) {
          order(id: $id) {
            name
            customer { id legacyResourceId tags }
            lineItems(first: 250) {
              nodes {
                legacyResourceId
                quantity
                discountedTotalSet { shopMoney { amount currencyCode } }
                product { id tags }
              }
            }
          }
        }
      `;

      type OrderForRefund = {
        order: null | {
          name: string;
          customer: null | { legacyResourceId: string; tags: string[] };
          lineItems: { nodes: Array<any> };
        };
      };

      const od = await shopifyGraphql<OrderForRefund>(shop, q, { id: orderGid });
      const lineByLegacyId = new Map<string, any>();
      for (const li of od.order?.lineItems?.nodes ?? []) {
        const legacy = String(li?.legacyResourceId ?? "");
        if (legacy) lineByLegacyId.set(legacy, li);
      }

      let eligibleRefundedCents = 0;
      for (const rli of refundLineItems) {
        const lineItemId = String(rli?.line_item_id ?? rli?.lineItemId ?? "");
        const qtyRefunded = clampInt(Number(rli?.quantity ?? 0));
        if (!lineItemId || qtyRefunded <= 0) continue;

        const orderLi = lineByLegacyId.get(lineItemId);
        if (!orderLi) continue;

        const totalAmountCents = moneyToCents(orderLi?.discountedTotalSet?.shopMoney?.amount);
        const qtyOrdered = clampInt(Number(orderLi?.quantity ?? 0));
        if (qtyOrdered <= 0) continue;

        const perUnitCents = Math.round(totalAmountCents / qtyOrdered);
        const refundedCents = perUnitCents * qtyRefunded;

        const tags = Array.isArray(orderLi?.product?.tags) ? orderLi.product.tags : [];
        const eligible = isEligibleByTags(tags, settings.includeProductTags, settings.excludeProductTags);
        if (!eligible) continue;

        if (refundedCents > 0) eligibleRefundedCents += refundedCents;
      }

      const earnRate = clampInt(settings.earnRate ?? 1);
      const computedReverse = Math.max(0, Math.floor((eligibleRefundedCents * earnRate) / 100));
      const pointsToReverse = Math.min(remaining, computedReverse);

      if (pointsToReverse <= 0) {
        await markWebhookProcessed(shop, webhookId, WebhookOutcome.PROCESSED, "REVERSE_0", "Refund contained no eligible value for reversal.");
        return new Response("ok", { status: 200 });
      }

      // Apply reversal and update snapshot
      await applyPointsDelta({
        shop,
        customerId: snapshot.customerId,
        delta: -pointsToReverse,
        ledgerType: "REVERSAL",
        source: "REFUND",
        sourceId: refundId,
        description: `Reversed ${pointsToReverse} points due to refund ${refundId} (order ${snapshot.orderName || orderId}).`,
      });

      await db.orderPointsSnapshot.update({
        where: { shop_orderId: { shop, orderId } },
        data: { pointsReversedToDate: { increment: pointsToReverse } },
      });

      await markWebhookProcessed(shop, webhookId, WebhookOutcome.PROCESSED, "REFUND_OK", null);
      return new Response("ok", { status: 200 });
    }

    if (topicNorm === "orders/cancelled") {
      const orderId = String(payload?.id ?? "");
      if (!orderId) {
        await markWebhookProcessed(shop, webhookId, WebhookOutcome.SKIPPED, "MISSING_ORDER", "Missing orderId in payload.");
        return new Response("ok", { status: 200 });
      }

      const snapshot = await db.orderPointsSnapshot.findUnique({
        where: { shop_orderId: { shop, orderId } },
      });

      if (!snapshot?.customerId) {
        await markWebhookProcessed(shop, webhookId, WebhookOutcome.SKIPPED, "NO_SNAPSHOT", "No order snapshot found.");
        return new Response("ok", { status: 200 });
      }

      const remaining = Math.max(0, snapshot.pointsAwarded - snapshot.pointsReversedToDate);
      if (remaining <= 0) {
        await markWebhookProcessed(shop, webhookId, WebhookOutcome.SKIPPED, "NO_REMAINING", "No remaining points to reverse.");
        return new Response("ok", { status: 200 });
      }

      await applyPointsDelta({
        shop,
        customerId: snapshot.customerId,
        delta: -remaining,
        ledgerType: "REVERSAL",
        source: "CANCEL",
        sourceId: orderId,
        description: `Reversed ${remaining} points due to order cancellation ${snapshot.orderName || orderId}.`,
      });

      await db.orderPointsSnapshot.update({
        where: { shop_orderId: { shop, orderId } },
        data: {
          pointsReversedToDate: { increment: remaining },
          cancelledAt: payload?.cancelled_at ? new Date(payload.cancelled_at) : new Date(),
        },
      });

      await markWebhookProcessed(shop, webhookId, WebhookOutcome.PROCESSED, "CANCEL_OK", null);
      return new Response("ok", { status: 200 });
    }

    // Unhandled topic
    await markWebhookProcessed(shop, webhookId, WebhookOutcome.SKIPPED, "TOPIC_UNHANDLED", `Unhandled topic ${topicNorm}`);
    return new Response("ok", { status: 200 });
  } catch (err) {
    await logWebhookError(shop, topicNorm, webhookId, payload, err);
    try {
      await markWebhookProcessed(shop, webhookId, WebhookOutcome.FAILED, "PROCESSING_ERROR", err instanceof Error ? err.message : "Unknown error");
    } catch {
      // ignore
    }
    // Return 200 to prevent retry storms; failures are recorded for admin review (FR-6.2).
    return new Response("ok", { status: 200 });
  }
};
