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
  let shop: string;
  let topic: string;
  let webhookId: string;
  let payload: any;
  let admin: any;

  const cloned = request.clone();

  try {
    ({ shop, topic, webhookId, payload, admin } = await authenticate.webhook(request));
  } catch (e: any) {
    const hdrShop = cloned.headers.get("X-Shopify-Shop-Domain") ?? "unknown";
    const hdrTopic = cloned.headers.get("X-Shopify-Topic") ?? "AUTH";
    const hdrWebhookId = cloned.headers.get("X-Shopify-Webhook-Id");

    let bodyText = "";
    try {
      bodyText = await cloned.text();
    } catch {}

    let parsedPayload: any = null;
    try {
      parsedPayload = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      parsedPayload = bodyText ? { raw: bodyText } : null;
    }

    const errorMessage = `Webhook auth failed: ${String(e?.message ?? e ?? "Unknown error")}`;

    console.error("Webhook auth failed:", {
      shop: hdrShop,
      topic: hdrTopic,
      webhookId: hdrWebhookId,
      error: e,
    });

    // Persist auth failures too, otherwise Support/Webhooks pages show "(none)" and hide the real cause.
    try {
      await db.webhookError.create({
        data: {
          shop: hdrShop,
          topic: hdrTopic,
          webhookId: hdrWebhookId,
          resourceId: null,
          errorMessage: errorMessage.slice(0, 1000),
          stack: typeof e?.stack === "string" ? e.stack.slice(0, 4000) : null,
          payload: parsedPayload ?? {},
        },
      });
    } catch (persistErr) {
      console.error("Failed to persist webhook auth error:", persistErr);
    }

    return new Response("unauthorized", { status: 401 });
  }

  const rawTopic = topic;
  const topicNormalized = normalizeTopic(rawTopic);

  const resourceId = extractResourceId(topicNormalized, payload);

  // Deduplicate first. If we already have this webhookId for this shop, do nothing.
  const created = await ensureWebhookEventRow({ shop, webhookId, topic: rawTopic, resourceId, payload });
  if (!created) return new Response("ok", { status: 200 });

  try {
    let result: HandleResult;

    switch (topicNormalized) {
      case "customers/data_request":
      case "customers/redact":
      case "shop/redact":
        result = await handlePrivacyWebhook(shop, topicNormalized, payload);
        break;

      case "app/uninstalled":
        result = await handleAppUninstalled(shop);
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
        result = { outcome: "SKIPPED", message: `Unhandled topic ${rawTopic} (normalized=${topicNormalized})` };
        break;
    }

    await db.webhookEvent.update({
      where: { shop_webhookId: { shop, webhookId } },
      data: { processedAt: new Date(), outcome: result.outcome, outcomeMessage: result.message ?? null },
    });

    return new Response("ok", { status: 200 });
  } catch (e: any) {
    console.error("Webhook processing error:", { shop, topic: rawTopic, topicNormalized, webhookId, error: e });

    await db.webhookEvent.update({
      where: { shop_webhookId: { shop, webhookId } },
      data: {
        processedAt: new Date(),
        outcome: "FAILED",
        outcomeMessage: String(e?.message ?? e ?? "Unknown error").slice(0, 500),
      },
    });
// Persist a dedicated error record for easier diagnostics (separate from the WebhookEvent summary row).
try {
  await db.webhookError.create({
    data: {
      shop,
      topic: rawTopic,
      webhookId,
      resourceId,
      errorMessage: String(e?.message ?? e ?? "Unknown error").slice(0, 1000),
      stack: typeof e?.stack === "string" ? e.stack.slice(0, 4000) : null,
      payload: payload ?? {},
    },
  });
} catch (logErr) {
  console.error("Failed to log WebhookError:", logErr);
}


    // Shopify expects 200 for webhooks; we log outcome as FAILED in DB.
    return new Response("error", { status: 200 });
  } finally {
    const ms = Date.now() - started.getTime();
    if (ms > 4000) console.warn(`Webhook ${rawTopic} (normalized=${topicNormalized}) (${webhookId}) took ${ms}ms`);
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



function normalizeTopic(topic: string): string {
  const t = (topic ?? "").trim();
  if (!t) return t;
  // REST-style topics like "orders/paid"
  if (t.includes("/")) return t.toLowerCase();

  // GraphQL enum topics like "ORDERS_PAID"
  const upper = t.toUpperCase();
  const map: Record<string, string> = {
    ORDERS_PAID: "orders/paid",
    ORDERS_CANCELLED: "orders/cancelled",
    REFUNDS_CREATE: "refunds/create",
    APP_UNINSTALLED: "app/uninstalled",
    CUSTOMERS_DATA_REQUEST: "customers/data_request",
    CUSTOMERS_REDACT: "customers/redact",
    SHOP_REDACT: "shop/redact",
  };

  return map[upper] ?? t.toLowerCase();
}


function extractResourceId(topic: string, payload: any): string {
  switch (topic) {
    case "orders/paid":
    case "orders/cancelled":
      return String(payload?.id ?? payload?.order_id ?? "unknown");
    case "refunds/create":
      return String(payload?.id ?? payload?.order_id ?? "unknown");
    case "app/uninstalled":
      return String(payload?.id ?? payload?.shop_id ?? "unknown");
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

async function handleAppUninstalled(shop: string): Promise<HandleResult> {
  // NOTE: Do NOT delete WebhookEvent rows here; the caller updates the current webhook row after this handler returns.
  // We intentionally remove all other shop-scoped data to prevent stale growth and ensure a clean reinstall.
  await db.$transaction([
    db.session.deleteMany({ where: { shop } }),
    db.shopSettings.deleteMany({ where: { shop } }),
    db.customerPointsBalance.deleteMany({ where: { shop } }),
    db.pointsLedger.deleteMany({ where: { shop } }),
    db.orderPointsSnapshot.deleteMany({ where: { shop } }),
    db.redemption.deleteMany({ where: { shop } }),
    db.privacyEvent.deleteMany({ where: { shop } }),
    db.webhookError.deleteMany({ where: { shop } }),
  ]);

  return { outcome: "PROCESSED", message: "App uninstalled: shop data cleaned up (sessions/settings/points/redemptions)." };
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

function normalizeProductId(id: unknown): string | null {
  if (id == null) return null;
  const s = String(id).trim();
  if (!s) return null;

  // Accept either numeric ids ("123") or full Shopify GIDs ("gid://shopify/Product/123").
  const m = s.match(/gid:\/\/shopify\/Product\/(\d+)/i);
  if (m?.[1]) return m[1];
  return s;
}

function makeProductIdSet(ids: string[]): Set<string> {
  const set = new Set<string>();
  for (const raw of ids ?? []) {
    const norm = normalizeProductId(raw);
    if (!norm) continue;

    // Store both forms so we can match either numeric ids or GIDs in payloads/settings.
    set.add(norm);
    set.add(`gid://shopify/Product/${norm}`);
  }
  return set;
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

type ProductEligibility = { tags: string[]; isExcludedByCollection: boolean };

async function fetchProductEligibilityMap(args: {
  adminGraphql: AdminGraphql;
  numericProductIds: string[];
  excludedCollectionHandles: string[];
}): Promise<Map<string, ProductEligibility>> {
  const { adminGraphql, numericProductIds, excludedCollectionHandles } = args;

  const gids = numericProductIds.map((id) => `gid://shopify/Product/${id}`);
  const excludedHandles = new Set(
    (excludedCollectionHandles ?? []).map((h) => String(h).trim().toLowerCase()).filter(Boolean),
  );

  // We intentionally query Product.collections and match by handle(s).
  // This supports "include all by default" with exclusions via collection handle(s).
  const query = `#graphql
    query ProductEligibilityAllByDefault($ids: [ID!]!) {
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

  const map = new Map<string, ProductEligibility>();

  for (const node of data?.nodes ?? []) {
    const numeric = String(node?.id ?? "").replace("gid://shopify/Product/", "");
    if (!numeric) continue;

    const collections = (node?.collections?.nodes ?? []).map((c: any) => String(c?.handle ?? "").trim().toLowerCase());
    const isExcludedByCollection =
      excludedHandles.size === 0 ? false : collections.some((h: string) => excludedHandles.has(h));

    map.set(numeric, {
      tags: (node?.tags ?? []).map((t: any) => String(t)),
      isExcludedByCollection,
    });
  }

  // Ensure every requested product id has an entry.
  // Shopify nodes() can return null (e.g., deleted product, permissions, transient API issues).
  // We default unknown products to eligible-by-default with no tags and not excluded-by-collection.
  // Tag include filters will still exclude these (since tags=[]), which is the safest default.
  for (const pid of numericProductIds ?? []) {
    if (!map.has(pid)) {
      map.set(pid, { tags: [], isExcludedByCollection: false });
    }
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
  excludedProductIds: Set<string>;
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

    if (args.excludedProductIds.has(pid)) continue;

    const info = args.productEligibility.get(pid) ?? { tags: [], isExcludedByCollection: false };
    if (info.isExcludedByCollection) continue;
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
  excludedProductIds: Set<string>;
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

    if (args.excludedProductIds.has(pid)) continue;

    const info = args.productEligibility.get(pid) ?? { tags: [], isExcludedByCollection: false };
    if (info.isExcludedByCollection) continue;
    if (!isProductEligibleByTags(info.tags, include, exclude)) continue;

    total += net;
  }

  return Math.max(0, total);
}

function extractDiscountCodesFromOrderPayload(payload: any): string[] {
  const codes: string[] = [];

  const push = (v: any) => {
    if (typeof v !== "string") return;
    const c = v.trim().toUpperCase();
    if (!c) return;
    // Lions Creek discount codes are generated with an "LCR" prefix.
    if (!/^LCR[0-9A-Z-]*$/.test(c)) return;
    codes.push(c);
  };

  // 1) REST order payload shape
  if (Array.isArray(payload?.discount_codes)) {
    for (const d of payload.discount_codes) push(typeof d === "string" ? d : d?.code);
  }

  // 2) Common camelCase variants (GraphQL/event payloads)
  if (Array.isArray(payload?.discountCodes)) {
    for (const d of payload.discountCodes) push(typeof d === "string" ? d : d?.code);
  }

  // 3) Discount applications (REST)
  if (Array.isArray(payload?.discount_applications)) {
    for (const a of payload.discount_applications) {
      // Some shapes include "code" directly for discount codes
      push(a?.code);
      // Sometimes nested
      push(a?.discount_code);
      push(a?.discountCode);
    }
  }

  // 4) Discount applications (GraphQL-ish)
  const da = payload?.discountApplications;
  if (Array.isArray(da)) {
    for (const a of da) push(a?.code);
  } else if (da?.edges && Array.isArray(da.edges)) {
    for (const e of da.edges) push(e?.node?.code);
  }

  // 5) Last-resort: walk payload for any { ... discount ... code: "LCR-..." } strings
  if (!codes.length && payload && typeof payload === "object") {
    const queue: Array<{ v: any; path: string[] }> = [{ v: payload, path: [] }];
    const seen = new Set<any>();
    let steps = 0;

    while (queue.length && steps++ < 5000) {
      const { v, path } = queue.shift()!;
      if (!v || typeof v !== "object") continue;
      if (seen.has(v)) continue;
      seen.add(v);

      if (Array.isArray(v)) {
        for (const item of v) queue.push({ v: item, path });
        continue;
      }

      for (const [k, val] of Object.entries(v)) {
        const nextPath = [...path, String(k)];
        if (typeof val === "string") {
          const lk = String(k).toLowerCase();
          const hasDiscountContext = nextPath.some((p) => p.toLowerCase().includes("discount"));
          if (hasDiscountContext && lk.includes("code")) push(val);
        } else if (val && typeof val === "object") {
          queue.push({ v: val, path: nextPath });
        }
      }
    }
  }

  // Deduplicate (preserve first occurrence)
  return Array.from(new Set(codes));
}

async function consumeRedemptionsFromOrder(shop: string, customerId: string, orderId: string, payload: any) {
  const codes = extractDiscountCodesFromOrderPayload(payload);

  if (!codes.length) return 0;

  let consumed = 0;
  const now = new Date();

  for (const code of codes) {
    // First try strict match (expected case): shop + customer + code
    const strict = await db.redemption.updateMany({
      where: { shop, customerId, code, status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] } },
      data: { status: RedemptionStatus.CONSUMED, appliedAt: now, consumedAt: now, consumedOrderId: orderId },
    });

    if (strict.count > 0) {
      consumed += strict.count;
      continue;
    }

    // Fallback: if customerId formats drift (numeric vs GID), match by shop+code only, but update a single row by id.
    const byCode = await db.redemption.findFirst({
      where: { shop, code, status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] } },
      select: { id: true },
    });

    if (!byCode) continue;

    await db.redemption.update({
      where: { id: byCode.id },
      data: { status: RedemptionStatus.CONSUMED, appliedAt: now, consumedAt: now, consumedOrderId: orderId },
    });

    consumed += 1;
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


  let eligibleNetCents = 0;

  // Only compute eligibility if not excluded (keeps program rules strict and avoids extra API calls for excluded customers).
  if (!excluded) {
    const productIds = collectProductIdsFromOrder(payload);
    const productEligibility = productIds.length
      ? await fetchProductEligibilityMap({
          adminGraphql,
          numericProductIds: productIds,
          excludedCollectionHandles: settings.excludedCollectionHandles,
        })
      : new Map<string, ProductEligibility>();

    eligibleNetCents = computeEligibleNetMerchCents({
      orderPayload: payload,
      productEligibility,
      includeProductTags: settings.includeProductTags,
      excludeProductTags: settings.excludeProductTags,
      excludedProductIds: makeProductIdSet(settings.excludedProductIds),
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

  if (!refundId || !orderId) {
    return { outcome: "SKIPPED", message: "Missing refund/order ids" };
  }

  const snapshot = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } } });
  if (!snapshot || snapshot.pointsAwarded <= 0) return { outcome: "SKIPPED", message: "No awarded points" };

  const customerId = String(snapshot.customerId);

  const remaining = Math.max(0, snapshot.pointsAwarded - snapshot.pointsReversedToDate);
  if (remaining <= 0) return { outcome: "SKIPPED", message: "Nothing to reverse" };

  // Idempotency guard. (We also have a DB unique constraint for refund dedupe.)
  const already = await db.pointsLedger.findFirst({
    where: { shop, type: LedgerType.REVERSAL, source: "REFUND", sourceId: refundId },
  });
  if (already) return { outcome: "SKIPPED", message: "Refund already processed" };

  if (!admin) return { outcome: "FAILED", message: "Missing admin client in webhook context" };
  const adminGraphql = makeAdminGraphql(admin);

  const refundLines = payload?.refund_line_items ?? [];

  const productIds = new Set<string>();
  for (const rli of refundLines) {
    const pid = rli?.line_item?.product_id;
    if (pid) productIds.add(String(pid));
  }

  const productEligibility = productIds.size
    ? await fetchProductEligibilityMap({
        adminGraphql,
        numericProductIds: Array.from(productIds),
        excludedCollectionHandles: settings.excludedCollectionHandles,
      })
    : new Map<string, ProductEligibility>();

  const eligibleRefundCents = computeEligibleRefundCents({
    refundLineItems: refundLines,
    productEligibility,
    includeProductTags: settings.includeProductTags,
    excludeProductTags: settings.excludeProductTags,
    excludedProductIds: makeProductIdSet(settings.excludedProductIds),
  });

  if (eligibleRefundCents <= 0) return { outcome: "SKIPPED", message: "No eligible refund cents" };

  const baseUnits = Math.floor(snapshot.eligibleNetMerchandise / 100);
  const refundUnits = Math.floor(eligibleRefundCents / 100);

  // Reverse proportionally to the original eligibility snapshot.
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
