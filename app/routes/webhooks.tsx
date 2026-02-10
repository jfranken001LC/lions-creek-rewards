import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";

export const loader = async (_args: LoaderFunctionArgs) => {
  return new Response("ok", { status: 200 });
};

function isPrismaUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as any).code === "P2002";
}

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

function safeJsonStringify(obj: any, maxLen = 3500): string {
  let s = "";
  try {
    s = JSON.stringify(obj);
  } catch {
    s = JSON.stringify({ error: "Could not stringify outcome details." });
  }
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

function extractNumericIdFromGid(gidOrId: string): string {
  const s = String(gidOrId || "").trim();
  if (!s) return "";
  const m = s.match(/\/(\d+)\s*$/);
  return m ? m[1] : s;
}

function normalizeTags(tags: any): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
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

async function shopifyGraphql(shop: string, query: string, variables: any) {
  const token = await getOfflineAccessToken(shop);
  if (!token) throw new Error(`Missing offline access token for shop ${shop}. Reinstall/re-auth the app.`);

  const endpoint = `https://${shop}/admin/api/2025-10/graphql.json`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Shopify GraphQL failed (${resp.status}): ${t}`);
  }

  const json = await resp.json().catch(() => null);
  if (json?.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json?.data;
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
      ? n.discountAllocations.reduce((sum: number, da: any) => sum + parseMoney(da?.allocatedAmountSet?.shopMoney?.amount), 0)
      : 0;

    const productTags: string[] =
      n?.variant?.product?.tags && Array.isArray(n.variant.product.tags) ? n.variant.product.tags.map((t: any) => String(t)) : [];

    return { quantity: Number(n?.quantity ?? 0) || 0, originalTotal, allocatedDiscountTotal, productTags };
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

function isEligibleByProductTags(productTags: string[], settings: any): boolean {
  const includeProductTags: string[] = (settings?.includeProductTags ?? []).map((t: any) => String(t).trim()).filter(Boolean);
  const excludeProductTags: string[] = (settings?.excludeProductTags ?? []).map((t: any) => String(t).trim()).filter(Boolean);

  const tags = (productTags ?? []).map((t) => String(t).trim()).filter(Boolean);

  const includedByTags = includeProductTags.length === 0 || tags.some((t) => includeProductTags.includes(t));
  const excludedByTags = excludeProductTags.length > 0 && tags.some((t) => excludeProductTags.includes(t));

  return includedByTags && !excludedByTags;
}

function computeEligibleFromOrder(
  order: OrderForPoints,
  settings: any,
): { eligibleNet: number; customerId: string | null; skipReason?: { code: string; message: string } } {
  const excludedCustomerTags: string[] = (settings?.excludedCustomerTags ?? []).map((t: any) => String(t).trim()).filter(Boolean);

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
    if (!isEligibleByProductTags(li.productTags ?? [], settings)) continue;
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

/** DEDUPE: have we already written a refund reversal ledger entry for this refund? */
async function refundReversalAlreadyApplied(shop: string, refundIdNumeric: string) {
  if (!refundIdNumeric) return false;
  const existing = await db.pointsLedger.findFirst({
    where: {
      shop,
      type: "REVERSAL",
      source: "REFUND",
      sourceId: refundIdNumeric,
    },
    select: { id: true },
  });
  return !!existing;
}

/**
 * Refund detail:
 * - refundLineItems subtotals + product tags (tag-accurate eligible subtotal)
 * - orderAdjustments + transactions for audit
 */
async function fetchRefundForReversal(shop: string, refundIdNumericOrGid: string, settings: any) {
  const numeric = extractNumericIdFromGid(refundIdNumericOrGid);
  const gid = refundIdNumericOrGid.startsWith("gid://") ? refundIdNumericOrGid : `gid://shopify/Refund/${numeric}`;

  const query = `
    query RefundForReversal($id: ID!) {
      refund(id: $id) {
        id
        createdAt
        note
        order { id currencyCode }
        refundLineItems(first: 250) {
          nodes {
            quantity
            subtotalSet { shopMoney { amount } }
            lineItem {
              id
              variant { product { tags } }
            }
          }
        }
        orderAdjustments(first: 50) {
          nodes {
            reason
            amountSet { shopMoney { amount } }
          }
        }
        transactions(first: 50) {
          nodes {
            kind
            status
            amountSet { shopMoney { amount } }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphql(shop, query, { id: gid });
  const refund = data?.refund;
  if (!refund) return { ok: false as const, reason: "REFUND_NOT_FOUND" };

  const currency = refund?.order?.currencyCode ? String(refund.order.currencyCode) : "CAD";
  const lineNodes: any[] = refund?.refundLineItems?.nodes ?? [];

  let eligibleRefundedSubtotal = 0;
  let totalRefundedMerchSubtotal = 0;

  const breakdown: Array<{ quantity: number; subtotal: number; eligible: boolean; tags: string[] }> = [];

  for (const n of lineNodes) {
    const subtotal = Math.max(0, parseMoney(n?.subtotalSet?.shopMoney?.amount));
    const tags = normalizeTags(n?.lineItem?.variant?.product?.tags);
    const eligible = isEligibleByProductTags(tags, settings);

    totalRefundedMerchSubtotal += subtotal;
    if (eligible) eligibleRefundedSubtotal += subtotal;

    breakdown.push({
      quantity: Number(n?.quantity ?? 0) || 0,
      subtotal,
      eligible,
      tags,
    });
  }

  const adjNodes: any[] = refund?.orderAdjustments?.nodes ?? [];
  const adjustments = adjNodes.map((n) => ({
    reason: n?.reason ? String(n.reason) : null,
    amount: parseMoney(n?.amountSet?.shopMoney?.amount),
  }));

  const txnNodes: any[] = refund?.transactions?.nodes ?? [];
  const transactions = txnNodes.map((n) => ({
    kind: n?.kind ? String(n.kind) : null,
    status: n?.status ? String(n.status) : null,
    amount: parseMoney(n?.amountSet?.shopMoney?.amount),
  }));

  const adjustmentsTotal = adjustments.reduce((s, a) => s + (a.amount || 0), 0);
  const transactionsTotal = transactions.reduce((s, t) => s + (t.amount || 0), 0);

  const hasMerchLines = lineNodes.length > 0;
  const hasNonMerchMoney = Math.abs(adjustmentsTotal) > 0.0001 || Math.abs(transactionsTotal) > 0.0001;

  return {
    ok: true as const,
    gid,
    currency,
    refundCreatedAt: refund?.createdAt ? String(refund.createdAt) : null,
    note: refund?.note ? String(refund.note) : null,
    hasMerchLines,
    lineCount: lineNodes.length,
    eligibleRefundedSubtotal,
    totalRefundedMerchSubtotal,
    breakdown: breakdown.slice(0, 25),
    adjustments,
    adjustmentsTotal,
    transactions,
    transactionsTotal,
    hasNonMerchMoney,
  };
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

  // Idempotency at webhook level (Shopify retries with same webhook-id sometimes)
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

        const existing = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } } });
        if (existing) {
          await markWebhookOutcome({ eventId, outcome: "SKIPPED", code: "DUPLICATE_ORDER_PAID", message: "Order already processed (snapshot exists)." });
          break;
        }

        const order = await fetchOrderForPoints(shop, orderId);
        if (!order) {
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
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: computed.skipReason?.code ?? "GUEST_ORDER",
            message: computed.skipReason?.message ?? "Guest order.",
          });
          break;
        }

        if (order.discountCodes?.length) {
          await consumeRedemptionsIfUsed({ shop, customerId, orderId, usedCodes: order.discountCodes });
        }

        if (computed.skipReason) {
          await markWebhookOutcome({ eventId, outcome: "SKIPPED", code: computed.skipReason.code, message: computed.skipReason.message });
          break;
        }

        const earnRate = Number(settings.earnRate ?? 1) || 1;
        const pointsEarned = clampInt(eligibleNet * earnRate, 0, 10_000_000);

        if (pointsEarned <= 0) {
          await markWebhookOutcome({ eventId, outcome: "SKIPPED", code: "ZERO_POINTS", message: "Eligible net computed, but points earned is 0 based on earnRate." });
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
            create: { shop, customerId, balance: pointsEarned, lifetimeEarned: pointsEarned, lifetimeRedeemed: 0, lastActivityAt: new Date() },
            update: { balance: { increment: pointsEarned }, lifetimeEarned: { increment: pointsEarned }, lastActivityAt: new Date() },
          });

          if (balanceRow.balance < 0) {
            await tx.customerPointsBalance.update({ where: { shop_customerId: { shop, customerId } }, data: { balance: 0 } });
          }
        });

        await markWebhookOutcome({
          eventId,
          outcome: "PROCESSED",
          code: "POINTS_AWARDED",
          message: safeJsonStringify({
            kind: "POINTS_AWARDED",
            shop,
            orderId,
            orderName,
            customerId,
            currency,
            eligibleNet,
            earnRate,
            pointsEarned,
          }),
        });

        break;
      }

      case "refunds/create": {
        const settings = await getShopSettings(shop);

        const orderId = String(payload?.order_id ?? payload?.order?.id ?? "");
        const refundIdRaw = String(payload?.admin_graphql_api_id ?? payload?.id ?? "");
        const refundIdNumeric = extractNumericIdFromGid(refundIdRaw);

        if (!orderId) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "MISSING_ORDER_ID",
            message: safeJsonStringify({ kind: "REFUND_SKIP", reason: "MISSING_ORDER_ID", refundId: refundIdRaw || null }),
          });
          break;
        }

        if (!refundIdNumeric) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "MISSING_REFUND_ID",
            message: safeJsonStringify({ kind: "REFUND_SKIP", reason: "MISSING_REFUND_ID", shop, orderId }),
          });
          break;
        }

        // ✅ DEDUPE: if a reversal ledger entry already exists for this refund, skip safely
        if (await refundReversalAlreadyApplied(shop, refundIdNumeric)) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "DUPLICATE_REFUND_REVERSAL",
            message: safeJsonStringify({
              kind: "REFUND_SKIP_DUPLICATE",
              shop,
              orderId,
              refundId: refundIdNumeric,
              notes: "A REVERSAL ledger entry already exists for this refundId (source=REFUND). Webhook skipped to prevent double reversal.",
            }),
          });
          break;
        }

        const snap = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } } });
        if (!snap) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "NO_SNAPSHOT",
            message: safeJsonStringify({ kind: "REFUND_SKIP", reason: "NO_SNAPSHOT", shop, orderId, refundId: refundIdNumeric }),
          });
          break;
        }

        const pointsAwarded = snap.pointsAwarded ?? 0;
        const pointsReversedToDate = snap.pointsReversedToDate ?? 0;
        const remainingAwardable = Math.max(0, pointsAwarded - pointsReversedToDate);

        if (pointsAwarded <= 0) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "NO_POINTS_AWARDED",
            message: safeJsonStringify({ kind: "REFUND_SKIP", reason: "NO_POINTS_AWARDED", shop, orderId, refundId: refundIdNumeric, pointsAwarded }),
          });
          break;
        }

        if (remainingAwardable <= 0) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "ALREADY_REVERSED",
            message: safeJsonStringify({ kind: "REFUND_SKIP", reason: "ALREADY_REVERSED", shop, orderId, refundId: refundIdNumeric, pointsAwarded, pointsReversedToDate }),
          });
          break;
        }

        const originalEligible = snap.eligibleNetMerchandise ?? 0;
        if (originalEligible <= 0) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "SNAPSHOT_ELIGIBLE_ZERO",
            message: safeJsonStringify({ kind: "REFUND_SKIP", reason: "SNAPSHOT_ELIGIBLE_ZERO", shop, orderId, refundId: refundIdNumeric, originalEligible }),
          });
          break;
        }

        let refundDetail: any;
        try {
          refundDetail = await fetchRefundForReversal(shop, refundIdRaw, settings);
        } catch (e: any) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "ADMIN_REFUND_FETCH_FAILED",
            message: safeJsonStringify({
              kind: "REFUND_SKIP",
              reason: "ADMIN_REFUND_FETCH_FAILED",
              shop,
              orderId,
              refundId: refundIdNumeric,
              error: String(e?.message ?? e),
            }),
          });
          break;
        }

        if (!refundDetail?.ok) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: refundDetail?.reason ?? "REFUND_NOT_FOUND",
            message: safeJsonStringify({ kind: "REFUND_SKIP", reason: refundDetail?.reason ?? "REFUND_NOT_FOUND", shop, orderId, refundId: refundIdNumeric }),
          });
          break;
        }

        const currency = snap.currency ?? refundDetail.currency ?? "CAD";

        if (!refundDetail.hasMerchLines) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "NON_MERCH_REFUND",
            message: safeJsonStringify({
              kind: "REFUND_SKIP_NON_MERCH",
              shop,
              orderId,
              refundId: refundIdNumeric,
              currency,
              pointsAwarded,
              pointsReversedToDate,
              remainingAwardable,
              originalEligible,
              hasMerchLines: refundDetail.hasMerchLines,
              hasNonMerchMoney: refundDetail.hasNonMerchMoney,
              adjustments: refundDetail.adjustments,
              adjustmentsTotal: refundDetail.adjustmentsTotal,
              transactions: refundDetail.transactions,
              transactionsTotal: refundDetail.transactionsTotal,
              refundCreatedAt: refundDetail.refundCreatedAt,
              note: refundDetail.note,
              notes: "Refund contains no refundLineItems; treated as shipping/duty/adjustment-only refund. Points reversal skipped.",
            }),
          });
          break;
        }

        const eligibleRefundedSubtotal = Number(refundDetail.eligibleRefundedSubtotal ?? 0) || 0;
        const totalRefundedMerchSubtotal = Number(refundDetail.totalRefundedMerchSubtotal ?? 0) || 0;

        if (eligibleRefundedSubtotal <= 0) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "NO_ELIGIBLE_REFUND_LINES",
            message: safeJsonStringify({
              kind: "REFUND_SKIP",
              reason: "NO_ELIGIBLE_REFUND_LINES",
              shop,
              orderId,
              refundId: refundIdNumeric,
              currency,
              pointsAwarded,
              pointsReversedToDate,
              remainingAwardable,
              originalEligible,
              totalRefundedMerchSubtotal,
              eligibleRefundedSubtotal,
              lineCount: refundDetail.lineCount,
              breakdown: refundDetail.breakdown,
              adjustments: refundDetail.adjustments,
              adjustmentsTotal: refundDetail.adjustmentsTotal,
              transactions: refundDetail.transactions,
              transactionsTotal: refundDetail.transactionsTotal,
              refundCreatedAt: refundDetail.refundCreatedAt,
              note: refundDetail.note,
              notes: "Refund has merch lines, but none are eligible by tag rules. Points reversal skipped.",
            }),
          });
          break;
        }

        const proportion = Math.min(1, Math.max(0, eligibleRefundedSubtotal / originalEligible));
        const pointsToReverse = clampInt(remainingAwardable * proportion, 0, remainingAwardable);

        if (pointsToReverse <= 0) {
          await markWebhookOutcome({
            eventId,
            outcome: "SKIPPED",
            code: "ZERO_REVERSAL",
            message: safeJsonStringify({
              kind: "REFUND_SKIP",
              reason: "ZERO_REVERSAL",
              shop,
              orderId,
              refundId: refundIdNumeric,
              currency,
              eligibleRefundedSubtotal,
              totalRefundedMerchSubtotal,
              originalEligible,
              proportion,
              remainingAwardable,
              computed: 0,
              breakdown: refundDetail.breakdown,
              adjustments: refundDetail.adjustments,
              adjustmentsTotal: refundDetail.adjustmentsTotal,
              transactions: refundDetail.transactions,
              transactionsTotal: refundDetail.transactionsTotal,
            }),
          });
          break;
        }

        const customerId = snap.customerId;
        const description = `Reversal on refund for order ${orderId}`;

        

// ...

const result = await db.$transaction(async (tx) => {
  // 1) Attempt to create the dedupe-keyed ledger row FIRST.
  //    If this hits the unique constraint, we abort the reversal safely.
  try {
    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: "REVERSAL",
        delta: -pointsToReverse,
        source: "REFUND",
        sourceId: refundIdNumeric, // <— critical: this matches your dedupe key
        description,
        createdAt: new Date(),
      },
    });
  } catch (e) {
    if (isPrismaUniqueViolation(e)) {
      return { duplicate: true as const };
    }
    throw e;
  }

  // 2) Only if ledger row was created, apply the balance/snapshot updates.
  await tx.customerPointsBalance.update({
    where: { shop_customerId: { shop, customerId } },
    data: { balance: { decrement: pointsToReverse }, lastActivityAt: new Date() },
  });

  await tx.orderPointsSnapshot.update({
    where: { shop_orderId: { shop, orderId } },
    data: { pointsReversedToDate: { increment: pointsToReverse } },
  });

  // clamp negative balance defensively
  const b = await tx.customerPointsBalance.findUnique({ where: { shop_customerId: { shop, customerId } } });
  if (b && b.balance < 0) {
    await tx.customerPointsBalance.update({
      where: { shop_customerId: { shop, customerId } },
      data: { balance: 0 },
    });
  }

  return { duplicate: false as const };
});

// If it was a race duplicate, record SKIPPED and exit cleanly.
if (result.duplicate) {
  await markWebhookOutcome({
    eventId,
    outcome: "SKIPPED",
    code: "DUPLICATE_REFUND_REVERSAL",
    message: safeJsonStringify({
      kind: "REFUND_SKIP_DUPLICATE_RACE",
      shop,
      orderId,
      refundId: refundIdNumeric,
      notes: "Unique constraint prevented a double refund reversal during concurrent webhook processing.",
    }),
  });

  break; // <-- exit the refunds/create handler
}

        await markWebhookOutcome({
          eventId,
          outcome: "PROCESSED",
          code: "POINTS_REVERSED_REFUND_TAG_ACCURATE",
          message: safeJsonStringify({
            kind: "POINTS_REVERSED_REFUND_TAG_ACCURATE",
            shop,
            orderId,
            refundId: refundIdNumeric,
            customerId,
            currency,
            pointsAwarded,
            pointsReversedToDate,
            remainingAwardable,
            originalEligible,
            eligibleRefundedSubtotal,
            totalRefundedMerchSubtotal,
            proportion,
            pointsToReverse,
            refundCreatedAt: refundDetail.refundCreatedAt,
            refundGid: refundDetail.gid,
            lineCount: refundDetail.lineCount,
            breakdown: refundDetail.breakdown,
            adjustments: refundDetail.adjustments,
            adjustmentsTotal: refundDetail.adjustmentsTotal,
            transactions: refundDetail.transactions,
            transactionsTotal: refundDetail.transactionsTotal,
            notes: "Dedupe via pointsLedger(type=REVERSAL, source=REFUND, sourceId=refundId).",
          }),
        });

        break;
      }

      default:
        await markWebhookOutcome({
          eventId,
          outcome: "PROCESSED",
          code: "IGNORED_TOPIC",
          message: safeJsonStringify({ kind: "IGNORED_TOPIC", topic, shop }),
        });
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
        message: safeJsonStringify({ kind: "EXCEPTION", topic, shop, error: String((err as any)?.message ?? err) }),
      });
    }
  }

  return new Response(null, { status: 200 });
};
