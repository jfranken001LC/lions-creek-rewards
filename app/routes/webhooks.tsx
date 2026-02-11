import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";

/**
 * POST /webhooks
 * Shopify webhooks endpoint.
 *
 * Handles:
 * - orders/paid
 * - refunds/create
 * - orders/cancelled
 * - app/uninstalled
 * - app/scopes_update
 * - customers/data_request
 * - customers/redact
 * - shop/redact
 *
 * Notes:
 * - Uses Shopify HMAC verification (X-Shopify-Hmac-Sha256).
 * - Dedupes by (shop, webhookId) in WebhookEvent.
 * - Refund reversals dedupe by refund id (sourceId = refundId).
 * - Refund/cancel reversals do NOT update lastActivityAt (expiry timer safety).
 */

type Outcome = "RECEIVED" | "PROCESSED" | "SKIPPED" | "FAILED";

function safeJsonStringify(obj: any, maxLen = 3500): string {
  let s = "";
  try {
    s = JSON.stringify(obj);
  } catch {
    s = JSON.stringify({ error: "Could not stringify." });
  }
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
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

async function getShopSettings(shop: string) {
  const defaults = {
    earnRate: 1,
    redemptionMinOrder: 0,
    excludedCustomerTags: ["Wholesale"],
    includeProductTags: [] as string[],
    excludeProductTags: [] as string[],
    redemptionSteps: [500, 1000],
    redemptionValueMap: { "500": 10, "1000": 20 } as Record<string, number>,
  };

  const existing = await db.shopSettings.findUnique({ where: { shop } }).catch(() => null);
  if (!existing) return defaults;

  const stepsRaw = (existing as any).redemptionSteps ?? defaults.redemptionSteps;
  const steps =
    Array.isArray(stepsRaw) && stepsRaw.length
      ? stepsRaw.map((x: any) => Number(x)).filter((n: any) => Number.isFinite(n))
      : defaults.redemptionSteps;

  return {
    ...defaults,
    ...existing,
    excludedCustomerTags: toStringListJson((existing as any).excludedCustomerTags) || defaults.excludedCustomerTags,
    includeProductTags: toStringListJson((existing as any).includeProductTags) || defaults.includeProductTags,
    excludeProductTags: toStringListJson((existing as any).excludeProductTags) || defaults.excludeProductTags,
    redemptionSteps: steps.length ? steps : defaults.redemptionSteps,
    redemptionValueMap: (existing as any).redemptionValueMap ?? defaults.redemptionValueMap,
  };
}

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const s = await db.session.findUnique({ where: { id } }).catch(() => null);
  return s?.accessToken ?? null;
}

async function shopifyGraphql(shop: string, query: string, variables: any) {
  const token = await getOfflineAccessToken(shop);
  if (!token) throw new Error(`Missing offline access token for shop ${shop}. Reinstall/re-auth the app.`);

  const endpoint = `https://${shop}/admin/api/2026-01/graphql.json`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
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

async function getProductTags(shop: string, productIdNumeric: any): Promise<string[]> {
  const pid = String(productIdNumeric ?? "").trim();
  if (!pid) return [];
  const gid = `gid://shopify/Product/${pid}`;

  const query = `
    query ProductTags($id: ID!) {
      product(id: $id) { tags }
    }
  `;

  const data = await shopifyGraphql(shop, query, { id: gid });
  const tags: any[] = data?.product?.tags ?? [];
  return Array.isArray(tags) ? tags.map((t) => String(t)) : [];
}

function isEligibleByTags(productTags: string[], includeTags: string[], excludeTags: string[]) {
  const tags = new Set(productTags.map((t) => t.trim()).filter(Boolean));

  const includes = includeTags.map((t) => t.trim()).filter(Boolean);
  const excludes = excludeTags.map((t) => t.trim()).filter(Boolean);

  if (excludes.some((t) => tags.has(t))) return false;

  if (includes.length === 0) return true;
  return includes.some((t) => tags.has(t));
}

async function verifyShopifyWebhookHmac(bodyText: string, hmacHeader: string): Promise<boolean> {
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  if (!secret || !hmacHeader) return false;

  const crypto = await import("node:crypto");
  const computed = crypto.createHmac("sha256", secret).update(bodyText, "utf8").digest("base64");

  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(hmacHeader, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const loader = async (_args: LoaderFunctionArgs) => {
  return new Response("Method Not Allowed", { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // Headers
  const topic = (request.headers.get("X-Shopify-Topic") ?? "unknown").toLowerCase();
  const shop = (request.headers.get("X-Shopify-Shop-Domain") ?? "").toLowerCase();
  const webhookId = request.headers.get("X-Shopify-Webhook-Id") ?? "";
  const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256") ?? "";

  const bodyText = await request.text();

  // Basic validation
  if (!shop || !webhookId) return new Response("Bad Request", { status: 400 });

  // HMAC verify
  const ok = await verifyShopifyWebhookHmac(bodyText, hmacHeader);
  if (!ok) return new Response("Unauthorized", { status: 401 });

  // Parse payload
  let payload: any = {};
  try {
    payload = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    payload = {};
  }

  // Dedupe by webhookId
  const resourceId = String(payload?.id ?? payload?.order_id ?? payload?.customer?.id ?? "");
  try {
    await db.webhookEvent.create({
      data: {
        shop,
        webhookId,
        topic,
        resourceId,
        receivedAt: new Date(),
        outcome: "RECEIVED" as any,
      } as any,
    });
  } catch {
    // Already processed
    return new Response(JSON.stringify({ ok: true, deduped: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  let outcome: Outcome = "PROCESSED";
  let outcomeCode: string | null = null;
  let outcomeMessage: string | null = null;

  try {
    // Privacy topics
    if (
      topic === "customers/data_request" ||
      topic === "customers/redact" ||
      topic === "shop/redact"
    ) {
      const counts = await handlePrivacy(topic, shop, payload);
      outcome = "PROCESSED";
      outcomeCode = "privacy";
      outcomeMessage = safeJsonStringify({ counts });
    }
    // App lifecycle
    else if (topic === "app/uninstalled") {
      const counts = await handleUninstalled(shop);
      outcome = "PROCESSED";
      outcomeCode = "uninstalled";
      outcomeMessage = safeJsonStringify({ counts });
    } else if (topic === "app/scopes_update") {
      outcome = "PROCESSED";
      outcomeCode = "scopes_update";
      outcomeMessage = "ack";
    }
    // Loyalty topics
    else if (topic === "orders/paid") {
      const res = await handleOrdersPaid(shop, payload);
      outcome = res.outcome;
      outcomeCode = res.code;
      outcomeMessage = res.message;
    } else if (topic === "refunds/create") {
      const res = await handleRefundCreate(shop, payload);
      outcome = res.outcome;
      outcomeCode = res.code;
      outcomeMessage = res.message;
    } else if (topic === "orders/cancelled") {
      const res = await handleOrderCancelled(shop, payload);
      outcome = res.outcome;
      outcomeCode = res.code;
      outcomeMessage = res.message;
    } else {
      outcome = "SKIPPED";
      outcomeCode = "unhandled_topic";
      outcomeMessage = topic;
    }

    await db.webhookEvent.update({
      where: { shop_webhookId: { shop, webhookId } as any },
      data: {
        outcome: outcome as any,
        outcomeCode,
        outcomeMessage,
        processedAt: new Date(),
      } as any,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    const errText = String(e?.message ?? e ?? "Unknown error");

    await db.webhookError
      .create({
        data: {
          shop,
          topic,
          webhookId,
          error: errText,
          createdAt: new Date(),
        },
      })
      .catch(() => null);

    await db.webhookEvent
      .update({
        where: { shop_webhookId: { shop, webhookId } as any },
        data: {
          outcome: "FAILED" as any,
          outcomeCode: "exception",
          outcomeMessage: errText,
          processedAt: new Date(),
        } as any,
      })
      .catch(() => null);

    // Shopify expects 200 to stop retry storms if you’ve persisted the error.
    return new Response(JSON.stringify({ ok: false, error: errText }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
};

async function handleOrdersPaid(shop: string, order: any): Promise<{ outcome: Outcome; code: string; message: string }> {
  const settings = await getShopSettings(shop);

  const customerId = String(order?.customer?.id ?? "").trim();
  if (!customerId) {
    return { outcome: "SKIPPED", code: "no_customer", message: "Order has no customer." };
  }

  // Excluded customer tags
  const excludedCustomerTags = settings.excludedCustomerTags ?? [];
  const customerTagsRaw = order?.customer?.tags ?? "";
  const customerTags = String(customerTagsRaw)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (excludedCustomerTags.some((t: string) => customerTags.includes(t))) {
    return { outcome: "SKIPPED", code: "excluded_customer_tag", message: safeJsonStringify({ customerTags }) };
  }

  const orderId = String(order?.id ?? "").trim();
  if (!orderId) return { outcome: "SKIPPED", code: "no_order_id", message: "Missing order.id" };

  // Idempotency: if snapshot already exists, treat as processed
  const existing = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } as any } });
  if (existing) {
    // Still update redemption status (in case snapshot existed but consumption hadn’t been marked)
    await markConsumedRedemptionsFromOrder(shop, customerId, order).catch(() => null);
    return { outcome: "SKIPPED", code: "already_snapshot", message: "Snapshot exists." };
  }

  const includeTags = settings.includeProductTags ?? [];
  const excludeTags = settings.excludeProductTags ?? [];
  const earnRate = Number(settings.earnRate ?? 1) || 1;

  const lineItems: any[] = Array.isArray(order?.line_items) ? order.line_items : [];
  const productIds = Array.from(
    new Set(lineItems.map((li) => String(li?.product_id ?? "").trim()).filter(Boolean)),
  );

  const tagCache = new Map<string, string[]>();
  for (const pid of productIds) {
    // best effort: if product tag fetch fails, treat as ineligible when includeTags is set, else eligible
    try {
      const tags = await getProductTags(shop, pid);
      tagCache.set(pid, tags);
    } catch {
      tagCache.set(pid, []);
    }
  }

  let eligibleNet = 0;

  for (const li of lineItems) {
    const pid = String(li?.product_id ?? "").trim();
    const qty = Number(li?.quantity ?? 0) || 0;
    const price = moneyToNumber(li?.price ?? 0);
    const totalDiscount = moneyToNumber(li?.total_discount ?? 0);

    if (qty <= 0 || price <= 0) continue;

    let eligible = true;
    if (pid) {
      const tags = tagCache.get(pid) ?? [];
      eligible = isEligibleByTags(tags, includeTags, excludeTags);
    } else {
      eligible = includeTags.length === 0; // if includeTags is set, we can’t verify -> treat as ineligible
    }

    if (!eligible) continue;

    const gross = price * qty;
    const net = Math.max(0, gross - totalDiscount);
    eligibleNet += net;
  }

  // Points: floor(net * earnRate)
  const points = Math.max(0, Math.floor(eligibleNet * earnRate));
  const paidAt = new Date(order?.processed_at ?? order?.created_at ?? Date.now());
  const currency = String(order?.currency ?? "CAD");

  // Discount code audit
  const discountCodesJson = Array.isArray(order?.discount_codes) ? order.discount_codes : [];

  // Persist snapshot + ledger + balance
  await db.$transaction(async (tx) => {
    await tx.orderPointsSnapshot.create({
      data: {
        shop,
        orderId,
        orderName: String(order?.name ?? ""),
        customerId,
        eligibleNetMerchandise: eligibleNet,
        pointsAwarded: points,
        pointsReversedToDate: 0,
        paidAt,
        cancelledAt: null,
        currency,
        discountCodesJson: discountCodesJson as any,
      } as any,
    });

    if (points > 0) {
      await tx.pointsLedger.create({
        data: {
          shop,
          customerId,
          type: "EARN",
          delta: points,
          source: "ORDER_PAID",
          sourceId: orderId,
          description: `Earned ${points} points on eligible net merchandise ${eligibleNet.toFixed(2)} ${currency}`,
          createdAt: new Date(),
        },
      });

      await tx.customerPointsBalance.upsert({
        where: { shop_customerId: { shop, customerId } as any },
        create: {
          shop,
          customerId,
          balance: points,
          lifetimeEarned: points,
          lifetimeRedeemed: 0,
          lastActivityAt: new Date(),
        },
        update: {
          balance: { increment: points },
          lifetimeEarned: { increment: points },
          lastActivityAt: new Date(),
        },
      });
    }
  });

  // Mark consumed redemption codes if order used them
  await markConsumedRedemptionsFromOrder(shop, customerId, order).catch(() => null);

  return {
    outcome: "PROCESSED",
    code: "orders_paid",
    message: safeJsonStringify({ orderId, customerId, eligibleNet, points }),
  };
}

async function markConsumedRedemptionsFromOrder(shop: string, customerId: string, order: any) {
  const discountCodes: any[] = Array.isArray(order?.discount_codes) ? order.discount_codes : [];
  const codes = discountCodes
    .map((d) => String(d?.code ?? d?.discount_code ?? "").trim())
    .filter(Boolean);

  if (codes.length === 0) return;

  const now = new Date();
  const orderId = String(order?.id ?? "").trim();

  for (const code of codes) {
    await db.redemption.updateMany({
      where: {
        shop,
        customerId,
        code,
        status: { in: ["ISSUED", "APPLIED"] } as any,
      } as any,
      data: {
        status: "CONSUMED",
        consumedAt: now,
        consumedOrderId: orderId || null,
      } as any,
    });
  }
}

async function handleRefundCreate(shop: string, payload: any): Promise<{ outcome: Outcome; code: string; message: string }> {
  const refundId = String(payload?.id ?? "").trim();
  const orderId = String(payload?.order_id ?? "").trim();
  if (!refundId || !orderId) {
    return { outcome: "SKIPPED", code: "missing_ids", message: safeJsonStringify({ refundId, orderId }) };
  }

  const snapshot = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } as any } });
  if (!snapshot) {
    return { outcome: "SKIPPED", code: "no_snapshot", message: safeJsonStringify({ refundId, orderId }) };
  }

  const settings = await getShopSettings(shop);
  const includeTags = settings.includeProductTags ?? [];
  const excludeTags = settings.excludeProductTags ?? [];

  const refundLineItems: any[] = Array.isArray(payload?.refund_line_items) ? payload.refund_line_items : [];
  if (refundLineItems.length === 0) {
    return { outcome: "SKIPPED", code: "no_refund_lines", message: safeJsonStringify({ refundId, orderId }) };
  }

  // Determine eligible refunded net merchandise using tag checks
  const productIds = Array.from(
    new Set(
      refundLineItems
        .map((rli) => String(rli?.line_item?.product_id ?? rli?.line_item?.product?.id ?? "").trim())
        .filter(Boolean),
    ),
  );

  const tagCache = new Map<string, string[]>();
  for (const pid of productIds) {
    try {
      const tags = await getProductTags(shop, pid);
      tagCache.set(pid, tags);
    } catch {
      tagCache.set(pid, []);
    }
  }

  let eligibleRefundNet = 0;

  for (const rli of refundLineItems) {
    const li = rli?.line_item ?? {};
    const pid = String(li?.product_id ?? "").trim();
    const refundedQty = Number(rli?.quantity ?? 0) || 0;
    const originalQty = Number(li?.quantity ?? 0) || refundedQty;

    const price = moneyToNumber(li?.price ?? 0);
    const totalDiscount = moneyToNumber(li?.total_discount ?? 0);

    if (refundedQty <= 0 || price <= 0) continue;

    let eligible = true;
    if (pid) {
      const tags = tagCache.get(pid) ?? [];
      eligible = isEligibleByTags(tags, includeTags, excludeTags);
    } else {
      eligible = includeTags.length === 0;
    }
    if (!eligible) continue;

    const gross = price * refundedQty;

    // Allocate discount proportionally by quantity
    const discountPerUnit = originalQty > 0 ? totalDiscount / originalQty : 0;
    const allocatedDiscount = Math.max(0, discountPerUnit * refundedQty);

    const net = Math.max(0, gross - allocatedDiscount);
    eligibleRefundNet += net;
  }

  const eligibleOriginalNet = Number(snapshot.eligibleNetMerchandise ?? 0) || 0;
  const awarded = Number(snapshot.pointsAwarded ?? 0) || 0;
  const reversedToDate = Number(snapshot.pointsReversedToDate ?? 0) || 0;
  const remaining = Math.max(0, awarded - reversedToDate);

  if (remaining <= 0 || eligibleOriginalNet <= 0 || eligibleRefundNet <= 0) {
    return {
      outcome: "SKIPPED",
      code: "nothing_to_reverse",
      message: safeJsonStringify({ refundId, orderId, eligibleRefundNet, eligibleOriginalNet, awarded, reversedToDate }),
    };
  }

  const fraction = Math.min(1, eligibleRefundNet / eligibleOriginalNet);
  const proposed = Math.max(0, Math.round(awarded * fraction));
  const pointsToReverse = Math.min(remaining, proposed);

  if (pointsToReverse <= 0) {
    return {
      outcome: "SKIPPED",
      code: "zero_points",
      message: safeJsonStringify({ refundId, orderId, fraction, proposed, remaining }),
    };
  }

  const customerId = String(snapshot.customerId);

  // Apply reversal (dedupe by refund id)
  try {
    await db.$transaction(async (tx) => {
      await tx.pointsLedger.create({
        data: {
          shop,
          customerId,
          type: "REVERSAL",
          delta: -pointsToReverse,
          source: "REFUND",
          sourceId: refundId,
          description: `Refund reversal: -${pointsToReverse} points (refund ${refundId}, order ${orderId})`,
          createdAt: new Date(),
        },
      });

      await tx.orderPointsSnapshot.update({
        where: { shop_orderId: { shop, orderId } as any },
        data: {
          pointsReversedToDate: { increment: pointsToReverse },
        },
      });

      // decrement balance but do NOT update lastActivityAt
      const bal = await tx.customerPointsBalance.findUnique({ where: { shop_customerId: { shop, customerId } as any } });
      const currentBal = bal?.balance ?? 0;
      const newBal = Math.max(0, currentBal - pointsToReverse);

      if (bal) {
        await tx.customerPointsBalance.update({
          where: { shop_customerId: { shop, customerId } as any },
          data: { balance: newBal },
        });
      } else {
        await tx.customerPointsBalance.create({
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
    });
  } catch (e: any) {
    // Likely deduped via unique constraint
    return {
      outcome: "SKIPPED",
      code: "deduped_or_conflict",
      message: safeJsonStringify({ refundId, orderId, error: String(e?.message ?? e) }),
    };
  }

  return {
    outcome: "PROCESSED",
    code: "refund_reversal",
    message: safeJsonStringify({
      refundId,
      orderId,
      eligibleRefundNet,
      eligibleOriginalNet,
      fraction,
      pointsToReverse,
      remainingBefore: remaining,
    }),
  };
}

async function handleOrderCancelled(shop: string, order: any): Promise<{ outcome: Outcome; code: string; message: string }> {
  const orderId = String(order?.id ?? "").trim();
  if (!orderId) return { outcome: "SKIPPED", code: "no_order_id", message: "Missing order.id" };

  const snapshot = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } as any } });
  if (!snapshot) {
    return { outcome: "SKIPPED", code: "no_snapshot", message: safeJsonStringify({ orderId }) };
  }

  const awarded = Number(snapshot.pointsAwarded ?? 0) || 0;
  const reversedToDate = Number(snapshot.pointsReversedToDate ?? 0) || 0;
  const remaining = Math.max(0, awarded - reversedToDate);

  if (remaining <= 0) {
    // still set cancelledAt
    await db.orderPointsSnapshot.update({
      where: { shop_orderId: { shop, orderId } as any },
      data: { cancelledAt: new Date(order?.cancelled_at ?? Date.now()) },
    });
    return { outcome: "SKIPPED", code: "already_reversed", message: safeJsonStringify({ orderId }) };
  }

  const customerId = String(snapshot.customerId);

  // Cancellation reversal: dedupe by order id (one cancellation per order)
  try {
    await db.$transaction(async (tx) => {
      await tx.pointsLedger.create({
        data: {
          shop,
          customerId,
          type: "REVERSAL",
          delta: -remaining,
          source: "CANCEL",
          sourceId: orderId,
          description: `Cancellation reversal: -${remaining} points (order ${orderId})`,
          createdAt: new Date(),
        },
      });

      await tx.orderPointsSnapshot.update({
        where: { shop_orderId: { shop, orderId } as any },
        data: {
          pointsReversedToDate: awarded,
          cancelledAt: new Date(order?.cancelled_at ?? Date.now()),
        },
      });

      // decrement balance but do NOT update lastActivityAt
      const bal = await tx.customerPointsBalance.findUnique({ where: { shop_customerId: { shop, customerId } as any } });
      const currentBal = bal?.balance ?? 0;
      const newBal = Math.max(0, currentBal - remaining);

      if (bal) {
        await tx.customerPointsBalance.update({
          where: { shop_customerId: { shop, customerId } as any },
          data: { balance: newBal },
        });
      }
    });
  } catch (e: any) {
    return {
      outcome: "SKIPPED",
      code: "deduped_or_conflict",
      message: safeJsonStringify({ orderId, error: String(e?.message ?? e) }),
    };
  }

  return {
    outcome: "PROCESSED",
    code: "cancel_reversal",
    message: safeJsonStringify({ orderId, reversed: remaining }),
  };
}

async function handleUninstalled(shop: string) {
  // Purge shop-scoped data (best effort; order of deletes doesn’t matter since no FKs here)
  const redemptionsDeleted = await db.redemption.deleteMany({ where: { shop } }).then((r) => r.count).catch(() => 0);
  const balancesDeleted = await db.customerPointsBalance.deleteMany({ where: { shop } }).then((r) => r.count).catch(() => 0);
  const ledgerDeleted = await db.pointsLedger.deleteMany({ where: { shop } }).then((r) => r.count).catch(() => 0);
  const snapshotsDeleted = await db.orderPointsSnapshot.deleteMany({ where: { shop } }).then((r) => r.count).catch(() => 0);
  const settingsDeleted = await db.shopSettings.deleteMany({ where: { shop } }).then((r) => r.count).catch(() => 0);
  const webhookEventsDeleted = await db.webhookEvent.deleteMany({ where: { shop } }).then((r) => r.count).catch(() => 0);
  const webhookErrorsDeleted = await db.webhookError.deleteMany({ where: { shop } }).then((r) => r.count).catch(() => 0);
  const privacyDeleted = await db.privacyEvent.deleteMany({ where: { shop } }).then((r) => r.count).catch(() => 0);

  // Sessions: delete both offline_ and any online sessions for shop
  const sessionsDeleted = await db.session.deleteMany({ where: { shop } }).then((r) => r.count).catch(() => 0);

  return {
    redemptionsDeleted,
    balancesDeleted,
    ledgerDeleted,
    snapshotsDeleted,
    settingsDeleted,
    webhookEventsDeleted,
    webhookErrorsDeleted,
    privacyDeleted,
    sessionsDeleted,
  };
}

async function handlePrivacy(topic: string, shop: string, payload: any) {
  // Always log payload (Shopify compliance)
  await db.privacyEvent
    .create({
      data: {
        shop,
        topic,
        payloadJson: safeJsonStringify(payload, 15000),
        createdAt: new Date(),
      },
    })
    .catch(() => null);

  if (topic === "customers/data_request") {
    // No deletion required; just acknowledge and record.
    return { recorded: true };
  }

  if (topic === "customers/redact") {
    const customerId = String(payload?.customer?.id ?? "").trim();
    if (!customerId) return { recorded: true, customerId: null };

    const redemptionsDeleted = await db.redemption
      .deleteMany({ where: { shop, customerId } })
      .then((r) => r.count)
      .catch(() => 0);

    const balancesDeleted = await db.customerPointsBalance
      .deleteMany({ where: { shop, customerId } })
      .then((r) => r.count)
      .catch(() => 0);

    const ledgerDeleted = await db.pointsLedger
      .deleteMany({ where: { shop, customerId } })
      .then((r) => r.count)
      .catch(() => 0);

    const snapshotsDeleted = await db.orderPointsSnapshot
      .deleteMany({ where: { shop, customerId } })
      .then((r) => r.count)
      .catch(() => 0);

    return {
      recorded: true,
      customerId,
      redemptionsDeleted,
      balancesDeleted,
      ledgerDeleted,
      snapshotsDeleted,
    };
  }

  if (topic === "shop/redact") {
    const counts = await handleUninstalled(shop);
    return { recorded: true, ...counts };
  }

  return { recorded: true };
}

export default function WebhooksRoute() {
  // No UI – webhook endpoint only.
  return null;
}
