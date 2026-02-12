import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { getShopSettings } from "../lib/shopSettings.server";

/**
 * POST /webhooks
 * Shopify webhooks receiver endpoint.
 *
 * Webhooks are HMAC-verified using SHOPIFY_API_SECRET.
 * We log webhook processing outcome to WebhookEvent for debug/auditing.
 *
 * Points ledger model:
 * - On PAID orders: compute eligible net merchandise, multiply by earnRate, add EARN ledger, update balance.
 * - On REFUNDS/CANCELLED: compute reversal points (tag-accurate), write REVERSAL ledger, update balance.
 *
 * NOTE:
 * - Product eligibility is based on include/exclude product tags from ShopSettings.
 * - Customer exclusion is based on excludedCustomerTags from ShopSettings and customer tags from webhook payload.
 */

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024; // 1MB safety
const MAX_LOG_JSON_CHARS = 10_000;

type Outcome = "SUCCESS" | "IGNORED" | "FAILED";

function safeJsonStringify(obj: any, maxLen = MAX_LOG_JSON_CHARS) {
  let s = "";
  try {
    s = JSON.stringify(obj);
  } catch {
    s = JSON.stringify({ stringifyError: "Could not stringify." });
  }
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

function moneyToNumber(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  // Shopify REST sometimes has { amount: "12.34" }
  if (typeof v === "object" && v.amount != null) return moneyToNumber(v.amount);
  return 0;
}

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const session = await db.session.findUnique({ where: { id } }).catch(() => null);
  return session?.accessToken ?? null;
}

async function shopifyGraphql(shop: string, query: string, variables: any) {
  const token = await getOfflineAccessToken(shop);
  if (!token) throw new Error("Missing offline access token. Reinstall/re-auth the app.");

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

  const json = await resp.json().catch(() => ({} as any));

  if (!resp.ok) {
    throw new Error(`Shopify GraphQL HTTP ${resp.status}: ${safeJsonStringify(json)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${safeJsonStringify(json.errors)}`);
  }
  return json.data;
}

function verifyShopifyWebhookHmac(rawBody: string, hmacHeader: string | null, apiSecret: string): boolean {
  if (!hmacHeader) return false;
  const digest = require("node:crypto").createHmac("sha256", apiSecret).update(rawBody, "utf8").digest("base64");
  // timing safe compare
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(hmacHeader, "utf8");
  if (a.length !== b.length) return false;
  return require("node:crypto").timingSafeEqual(a, b);
}

async function logWebhookEvent({
  shop,
  topic,
  webhookId,
  outcome,
  message,
  payloadJson,
}: {
  shop: string;
  topic: string;
  webhookId: string | null;
  outcome: Outcome;
  message: string | null;
  payloadJson: string | null;
}) {
  await db.webhookEvent
    .create({
      data: {
        shop,
        topic,
        webhookId,
        outcome,
        message,
        payloadJson,
      },
    })
    .catch(() => null);
}

type OrderPayload = {
  id: number;
  name: string;
  financial_status?: string;
  cancelled_at?: string | null;

  customer?: {
    id: number;
    email?: string | null;
    tags?: string | null; // comma-separated string in REST payload
  } | null;

  line_items?: Array<{
    id: number;
    product_id?: number | null;
    variant_id?: number | null;
    title?: string;
    quantity: number;
    price?: string; // string
    total_discount?: string; // string
    // (rest has more)
  }>;

  subtotal_price?: string;
  total_discounts?: string;
  total_price?: string;
  total_tax?: string;

  currency?: string;

  refunds?: Array<{
    id: number;
    created_at?: string;
    refund_line_items?: Array<{
      line_item_id: number;
      quantity: number;
      subtotal?: number | string | { amount: string };
      total_tax?: number | string | { amount: string };
    }>;
    // transactions etc omitted
  }>;
};

function parseCustomerTagsString(tags: string | null | undefined): string[] {
  if (!tags) return [];
  return tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

async function getProductTagsById(shop: string, productGid: string): Promise<string[]> {
  const query = `
    query ProductTags($id: ID!) {
      product(id: $id) { tags }
    }
  `;
  const data = await shopifyGraphql(shop, query, { id: productGid });
  const tags: any[] = data?.product?.tags ?? [];
  return Array.isArray(tags) ? tags.map((t) => String(t)) : [];
}

function isEligibleByTags(productTags: string[], includeTags: string[], excludeTags: string[]): boolean {
  // Exclude always wins
  if (excludeTags.length && productTags.some((t) => excludeTags.includes(t))) return false;

  // If includes is empty -> everything eligible (unless excluded)
  if (!includeTags.length) return true;

  return productTags.some((t) => includeTags.includes(t));
}

function clampInt(n: any, min: number, max: number): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

async function ensureCustomerBalanceRow(shop: string, customerId: string) {
  const existing = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });
  if (existing) return existing;

  return db.customerPointsBalance.create({
    data: {
      shop,
      customerId,
      balance: 0,
      lifetimeEarned: 0,
      lifetimeRedeemed: 0,
      lastActivityAt: new Date(),
    },
  });
}

async function applyLedgerDelta({
  shop,
  customerId,
  type,
  delta,
  description,
  orderName,
  orderId,
}: {
  shop: string;
  customerId: string;
  type: string;
  delta: number;
  description: string;
  orderName: string | null;
  orderId: string | null;
}) {
  // Transaction: write ledger + update balance row
  await db.$transaction(async (tx) => {
    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type,
        delta,
        description,
        orderId,
        orderName,
      },
    });

    const bal = await tx.customerPointsBalance.upsert({
      where: { shop_customerId: { shop, customerId } },
      create: {
        shop,
        customerId,
        balance: delta,
        lifetimeEarned: delta > 0 ? delta : 0,
        lifetimeRedeemed: 0,
        lastActivityAt: new Date(),
      },
      update: {
        balance: { increment: delta },
        lifetimeEarned: delta > 0 ? { increment: delta } : undefined,
        lastActivityAt: new Date(),
      } as any,
    });

    // prevent negative balances from going too negative (optional clamp)
    if (bal.balance < 0) {
      await tx.customerPointsBalance.update({
        where: { shop_customerId: { shop, customerId } },
        data: { balance: 0 },
      });
    }
  });
}

function getNetLineMerchandise(line: any): number {
  // price is per-unit, total_discount is line-level total discount
  const qty = clampInt(line?.quantity ?? 0, 0, 1_000_000);
  const priceEach = moneyToNumber(line?.price);
  const gross = qty * priceEach;
  const discount = moneyToNumber(line?.total_discount);
  const net = gross - discount;
  return Math.max(0, net);
}

async function computeEligibleNetMerchandise(shop: string, payload: OrderPayload, includeTags: string[], excludeTags: string[]) {
  const lines = payload.line_items ?? [];
  // We compute line by line and query product tags as needed.
  // Cache product tags to avoid duplicate GraphQL calls.
  const productTagsCache = new Map<string, string[]>();

  let eligibleNet = 0;

  for (const line of lines) {
    const productId = line.product_id;
    if (!productId) continue;

    const productGid = `gid://shopify/Product/${productId}`;
    let tags = productTagsCache.get(productGid);
    if (!tags) {
      try {
        tags = await getProductTagsById(shop, productGid);
      } catch {
        tags = [];
      }
      productTagsCache.set(productGid, tags);
    }

    if (!isEligibleByTags(tags, includeTags, excludeTags)) continue;

    eligibleNet += getNetLineMerchandise(line);
  }

  return eligibleNet;
}

function computeRefundReversalNet(payload: OrderPayload): number {
  // Attempt to compute net merch refunded using refund_line_items.subtotal
  // Note: subtotal typically excludes tax. We use subtotal for reversal basis.
  const refunds = payload.refunds ?? [];
  let total = 0;
  for (const r of refunds) {
    for (const li of r.refund_line_items ?? []) {
      total += moneyToNumber(li.subtotal);
    }
  }
  return Math.max(0, total);
}

async function handlePaid(shop: string, payload: OrderPayload) {
  const customerId = payload.customer?.id ? String(payload.customer.id) : "";
  if (!customerId) return { outcome: "IGNORED" as Outcome, message: "No customer on order." };

  const settings = await getShopSettings(shop);

  // Excluded customer tags enforcement
  const customerTags = parseCustomerTagsString(payload.customer?.tags);
  const isExcludedCustomer = settings.excludedCustomerTags.some((t) => customerTags.includes(t));
  if (isExcludedCustomer) {
    return { outcome: "IGNORED" as Outcome, message: `Excluded customer tags: ${payload.customer?.tags ?? ""}` };
  }

  await ensureCustomerBalanceRow(shop, customerId);

  const eligibleNet = await computeEligibleNetMerchandise(
    shop,
    payload,
    settings.includeProductTags,
    settings.excludeProductTags,
  );

  const earnRate = clampInt(settings.earnRate, 1, 100);
  const points = Math.floor(eligibleNet * earnRate);

  if (points <= 0) {
    return { outcome: "IGNORED" as Outcome, message: "No eligible net merchandise to earn points." };
  }

  // Idempotency: do not re-earn if we already logged an EARN for this orderId.
  const orderId = String(payload.id);
  const existing = await db.pointsLedger.findFirst({
    where: { shop, customerId, type: "EARN", orderId },
    select: { id: true },
  });
  if (existing) {
    return { outcome: "IGNORED" as Outcome, message: "Already processed EARN for this order." };
  }

  await applyLedgerDelta({
    shop,
    customerId,
    type: "EARN",
    delta: points,
    description: `Earned ${points} points on eligible net merchandise $${eligibleNet.toFixed(2)} (rate ${earnRate}/$)`,
    orderId,
    orderName: payload.name ?? null,
  });

  return { outcome: "SUCCESS" as Outcome, message: `Earned ${points} points.` };
}

async function handleRefundOrCancel(shop: string, payload: OrderPayload, reason: "REFUND" | "CANCELLED") {
  const customerId = payload.customer?.id ? String(payload.customer.id) : "";
  if (!customerId) return { outcome: "IGNORED" as Outcome, message: "No customer on order." };

  const settings = await getShopSettings(shop);

  // Excluded customers: ignore (they shouldn't have earned, but safe)
  const customerTags = parseCustomerTagsString(payload.customer?.tags);
  const isExcludedCustomer = settings.excludedCustomerTags.some((t) => customerTags.includes(t));
  if (isExcludedCustomer) {
    return { outcome: "IGNORED" as Outcome, message: `Excluded customer tags: ${payload.customer?.tags ?? ""}` };
  }

  await ensureCustomerBalanceRow(shop, customerId);

  const orderId = String(payload.id);

  // Find original earned points for this order (if any)
  const earned = await db.pointsLedger.findFirst({
    where: { shop, customerId, type: "EARN", orderId },
    select: { id: true, delta: true },
  });
  if (!earned) {
    return { outcome: "IGNORED" as Outcome, message: "No prior EARN found for this order." };
  }

  // Idempotency: don't double reverse for same reason/order
  const existing = await db.pointsLedger.findFirst({
    where: { shop, customerId, type: `REVERSAL_${reason}`, orderId },
    select: { id: true },
  });
  if (existing) {
    return { outcome: "IGNORED" as Outcome, message: `Already processed ${reason} reversal for this order.` };
  }

  const earnRate = clampInt(settings.earnRate, 1, 100);

  // Compute reversal basis (refund net subtotal if present; else reverse full earned)
  // For cancellations, we reverse full earned.
  let reversalPoints = 0;
  if (reason === "CANCELLED") {
    reversalPoints = -Math.abs(earned.delta);
  } else {
    const refundedNet = computeRefundReversalNet(payload);
    reversalPoints = -Math.floor(refundedNet * earnRate);

    // Clamp reversal so we don't exceed original earned magnitude
    reversalPoints = -Math.min(Math.abs(reversalPoints), Math.abs(earned.delta));
  }

  if (reversalPoints === 0) {
    return { outcome: "IGNORED" as Outcome, message: "No reversal points computed." };
  }

  await applyLedgerDelta({
    shop,
    customerId,
    type: `REVERSAL_${reason}`,
    delta: reversalPoints,
    description:
      reason === "CANCELLED"
        ? `Reversed ${Math.abs(reversalPoints)} points due to order cancellation.`
        : `Reversed ${Math.abs(reversalPoints)} points due to refund (rate ${earnRate}/$).`,
    orderId,
    orderName: payload.name ?? null,
  });

  return { outcome: "SUCCESS" as Outcome, message: `Reversed ${Math.abs(reversalPoints)} points (${reason}).` };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";

  const topic = request.headers.get("X-Shopify-Topic") ?? "unknown";
  const shop = (request.headers.get("X-Shopify-Shop-Domain") ?? "").toLowerCase();
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");
  const hmac = request.headers.get("X-Shopify-Hmac-Sha256");

  // Read raw body (and cap size)
  const raw = await request.text();
  if (raw.length > MAX_WEBHOOK_BODY_BYTES) {
    await logWebhookEvent({
      shop: shop || "unknown",
      topic,
      webhookId,
      outcome: "FAILED",
      message: "Webhook body too large.",
      payloadJson: null,
    });
    return new Response("Payload too large", { status: 413 });
  }

  if (!shop) {
    await logWebhookEvent({
      shop: "unknown",
      topic,
      webhookId,
      outcome: "FAILED",
      message: "Missing shop domain header.",
      payloadJson: safeJsonStringify({ topic }),
    });
    return new Response("Missing shop", { status: 400 });
  }

  const okHmac = verifyShopifyWebhookHmac(raw, hmac, apiSecret);
  if (!okHmac) {
    await logWebhookEvent({
      shop,
      topic,
      webhookId,
      outcome: "FAILED",
      message: "HMAC verification failed.",
      payloadJson: safeJsonStringify({ topic }),
    });
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: OrderPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    await logWebhookEvent({
      shop,
      topic,
      webhookId,
      outcome: "FAILED",
      message: "Invalid JSON.",
      payloadJson: raw.slice(0, MAX_LOG_JSON_CHARS),
    });
    return new Response("Bad JSON", { status: 400 });
  }

  try {
    let res: { outcome: Outcome; message: string };

    // Topics differ by webhook configuration
    const normalized = topic.toLowerCase();

    if (normalized.includes("orders/paid")) {
      res = await handlePaid(shop, payload);
    } else if (normalized.includes("orders/cancelled")) {
      res = await handleRefundOrCancel(shop, payload, "CANCELLED");
    } else if (normalized.includes("refunds/create") || normalized.includes("orders/refunded")) {
      res = await handleRefundOrCancel(shop, payload, "REFUND");
    } else {
      res = { outcome: "IGNORED", message: `Unhandled topic: ${topic}` };
    }

    await logWebhookEvent({
      shop,
      topic,
      webhookId,
      outcome: res.outcome,
      message: res.message,
      payloadJson: safeJsonStringify(payload),
    });

    return new Response("OK", { status: 200 });
  } catch (e: any) {
    await logWebhookEvent({
      shop,
      topic,
      webhookId,
      outcome: "FAILED",
      message: String(e?.message ?? e),
      payloadJson: safeJsonStringify(payload),
    });
    return new Response("Webhook processing failed", { status: 500 });
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Health check / debug endpoint (optional)
  return new Response("OK", { status: 200 });
};
