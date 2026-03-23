import { LedgerType } from "@prisma/client";
import db from "../db.server";
import { apiVersion } from "../shopify.server";
import { buildTierProgress, computeEffectiveEarnRate, getCustomerTierMetrics, refreshCustomerTierSnapshot } from "./tier.server";
import { getOrCreateShopSettings, upsertShopSettings } from "./shopSettings.server";

export type HistoricalBackfillSummary = {
  runId: string;
  shop: string;
  startDate: string;
  throughDate: string;
  ordersScanned: number;
  awardedOrders: number;
  skippedOrders: number;
  pointsAwarded: number;
  refundsProcessed: number;
  cancellationsProcessed: number;
  errorCount: number;
  lastError: string | null;
  completedAt: string;
};

type AdminGraphql = (query: string, variables?: Record<string, any>) => Promise<any>;

type ProductEligibility = { tags: string[]; isExcludedByCollection: boolean };

type BackfillOrderNode = any;

const HISTORICAL_ORDERS_QUERY = `#graphql
  query HistoricalOrdersForLoyaltyBackfill($query: String!, $after: String) {
    orders(first: 50, after: $after, sortKey: CREATED_AT, reverse: false, query: $query) {
      edges {
        cursor
        node {
          id
          legacyResourceId
          name
          createdAt
          processedAt
          cancelledAt
          displayFinancialStatus
          customer {
            id
            legacyResourceId
            tags
          }
          lineItems(first: 250) {
            nodes {
              id
              quantity
              originalUnitPriceSet { shopMoney { amount } }
              discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
              totalDiscountSet { shopMoney { amount } }
              product {
                id
                legacyResourceId
                tags
                collections(first: 50) { nodes { handle } }
              }
            }
          }
          refunds(first: 100) {
            id
            createdAt
            refundLineItems(first: 250) {
              nodes {
                quantity
                subtotalSet { shopMoney { amount } }
                lineItem {
                  id
                  quantity
                  originalUnitPriceSet { shopMoney { amount } }
                  discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
                  totalDiscountSet { shopMoney { amount } }
                  product {
                    id
                    legacyResourceId
                    tags
                    collections(first: 50) { nodes { handle } }
                  }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const session = await db.session.findUnique({ where: { id } }).catch(() => null);
  return session?.accessToken ?? null;
}

function makeAdminGraphql(shop: string, accessToken: string): AdminGraphql {
  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  return async (query: string, variables?: Record<string, any>) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });

    const text = await response.text().catch(() => "");
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!response.ok) {
      throw new Error(`Shopify GraphQL failed: ${response.status} ${response.statusText}${text ? ` ${text}` : ""}`);
    }
    if (json?.errors?.length) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
    }

    return json?.data ?? null;
  };
}

function dayStartUtc(input: string): Date {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) throw new Error("Historical backfill start date is required.");
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) throw new Error("Historical backfill start date is invalid.");
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

function dayEndUtc(input: Date): Date {
  const d = new Date(input);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function numericIdFromShopifyId(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const m = s.match(/\/(\d+)(?:\?.*)?$/);
  if (m?.[1]) return m[1];
  return /^\d+$/.test(s) ? s : s;
}

function moneyToCents(raw: unknown): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n * 100));
}

function normalizeTags(tags: unknown): Set<string> {
  return new Set(
    (Array.isArray(tags) ? tags : [])
      .map((tag) => String(tag ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
}

function customerIsExcluded(customerTags: string[], excluded: string[]): boolean {
  if (!excluded?.length) return false;
  const have = new Set(customerTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  return excluded.some((t) => have.has(String(t).trim().toLowerCase()));
}

function makeProductIdSet(ids: string[]): Set<string> {
  const set = new Set<string>();
  for (const raw of ids ?? []) {
    const normalized = numericIdFromShopifyId(raw);
    if (!normalized) continue;
    set.add(normalized);
    set.add(`gid://shopify/Product/${normalized}`);
  }
  return set;
}

function isProductEligibleByTags(productTags: string[], includeTags: string[], excludeTags: string[]): boolean {
  const include = normalizeTags(includeTags);
  const exclude = normalizeTags(excludeTags);
  const tags = new Set(productTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  for (const ex of exclude) {
    if (tags.has(ex)) return false;
  }
  if (include.size === 0) return true;
  for (const inc of include) {
    if (tags.has(inc)) return true;
  }
  return false;
}

function buildProductEligibilityMap(orderNode: BackfillOrderNode, excludedCollectionHandles: string[]): Map<string, ProductEligibility> {
  const excludedHandles = new Set((excludedCollectionHandles ?? []).map((h) => String(h).trim().toLowerCase()).filter(Boolean));
  const map = new Map<string, ProductEligibility>();

  for (const line of orderNode?.lineItems?.nodes ?? []) {
    const product = line?.product;
    const numericProductId = numericIdFromShopifyId(product?.legacyResourceId ?? product?.id);
    if (!numericProductId) continue;
    const collections = (product?.collections?.nodes ?? []).map((node: any) => String(node?.handle ?? "").trim().toLowerCase());
    map.set(numericProductId, {
      tags: (product?.tags ?? []).map((tag: any) => String(tag)),
      isExcludedByCollection: collections.some((handle: string) => excludedHandles.has(handle)),
    });
  }

  return map;
}

function computeEligibleNetMerchandiseCents(orderNode: BackfillOrderNode, settings: Awaited<ReturnType<typeof getOrCreateShopSettings>>, productEligibility: Map<string, ProductEligibility>): number {
  const excludedProductIds = makeProductIdSet(settings.excludedProductIds);
  let total = 0;

  for (const line of orderNode?.lineItems?.nodes ?? []) {
    const quantity = Math.max(0, Number(line?.quantity ?? 0));
    if (!quantity) continue;

    const productId = numericIdFromShopifyId(line?.product?.legacyResourceId ?? line?.product?.id);
    if (!productId) continue;
    if (excludedProductIds.has(productId) || excludedProductIds.has(`gid://shopify/Product/${productId}`)) continue;

    const info = productEligibility.get(productId) ?? { tags: [], isExcludedByCollection: false };
    if (info.isExcludedByCollection) continue;
    if (!isProductEligibleByTags(info.tags, settings.includeProductTags, settings.excludeProductTags)) continue;

    const originalUnitCents = moneyToCents(line?.originalUnitPriceSet?.shopMoney?.amount);
    const discountedUnitCents = moneyToCents(
      line?.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount ??
        line?.originalUnitPriceSet?.shopMoney?.amount,
    );

    const gross = originalUnitCents * quantity;
    const discountedTotal = discountedUnitCents * quantity;
    const lineNet = Math.max(0, Math.min(gross, discountedTotal || gross));
    total += lineNet;
  }

  return Math.max(0, total);
}

function computeEligibleRefundCents(refundNode: any, settings: Awaited<ReturnType<typeof getOrCreateShopSettings>>): number {
  const excludedProductIds = makeProductIdSet(settings.excludedProductIds);
  let total = 0;

  for (const refundLine of refundNode?.refundLineItems?.nodes ?? []) {
    const lineItem = refundLine?.lineItem;
    const productId = numericIdFromShopifyId(lineItem?.product?.legacyResourceId ?? lineItem?.product?.id);
    if (!productId) continue;
    if (excludedProductIds.has(productId) || excludedProductIds.has(`gid://shopify/Product/${productId}`)) continue;

    const collections = (lineItem?.product?.collections?.nodes ?? []).map((node: any) => String(node?.handle ?? "").trim().toLowerCase());
    const isExcludedByCollection = (settings.excludedCollectionHandles ?? []).some((handle) => collections.includes(String(handle).trim().toLowerCase()));
    if (isExcludedByCollection) continue;

    const tags = (lineItem?.product?.tags ?? []).map((tag: any) => String(tag));
    if (!isProductEligibleByTags(tags, settings.includeProductTags, settings.excludeProductTags)) continue;

    total += moneyToCents(refundLine?.subtotalSet?.shopMoney?.amount);
  }

  return Math.max(0, total);
}

function normalizeFinancialStatus(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function shouldProcessOrder(orderNode: BackfillOrderNode): boolean {
  const status = normalizeFinancialStatus(orderNode?.displayFinancialStatus);
  return ["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(status);
}

async function applyBalanceDelta(
  tx: any,
  shop: string,
  customerId: string,
  delta: number,
  opts: { incEarned?: number; incRedeemed?: number; activityAt?: Date },
) {
  const activityAt = opts.activityAt ?? new Date();
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
        currentTierId: null,
        currentTierName: null,
        tierComputedAt: activityAt,
        lastActivityAt: activityAt,
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
      tierComputedAt: activityAt,
      lastActivityAt: activityAt,
      expiredAt: null,
    },
  });
}

async function processHistoricalOrder(
  shop: string,
  settings: Awaited<ReturnType<typeof getOrCreateShopSettings>>,
  orderNode: BackfillOrderNode,
): Promise<{
  scanned: number;
  awarded: number;
  skipped: number;
  pointsAwarded: number;
  refundsProcessed: number;
  cancellationsProcessed: number;
}> {
  const orderId = numericIdFromShopifyId(orderNode?.legacyResourceId ?? orderNode?.id);
  const orderName = String(orderNode?.name ?? orderId);
  const customerId = numericIdFromShopifyId(orderNode?.customer?.legacyResourceId ?? orderNode?.customer?.id);

  if (!orderId || !customerId || !shouldProcessOrder(orderNode)) {
    return { scanned: 1, awarded: 0, skipped: 1, pointsAwarded: 0, refundsProcessed: 0, cancellationsProcessed: 0 };
  }

  const paidAt = new Date(orderNode?.processedAt ?? orderNode?.createdAt ?? new Date());
  const cancelledAt = orderNode?.cancelledAt ? new Date(orderNode.cancelledAt) : null;
  const customerTags = Array.isArray(orderNode?.customer?.tags) ? orderNode.customer.tags.map((tag: any) => String(tag)) : [];
  const excludedCustomer = customerIsExcluded(customerTags, settings.excludedCustomerTags);
  const productEligibility = buildProductEligibilityMap(orderNode, settings.excludedCollectionHandles);
  const eligibleNetCents = excludedCustomer ? 0 : computeEligibleNetMerchandiseCents(orderNode, settings, productEligibility);

  let awarded = 0;
  let pointsAwarded = 0;
  let refundsProcessed = 0;
  let cancellationsProcessed = 0;
  let skipped = 0;

  let snapshot = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } } });

  if (!snapshot) {
    const currentMetrics = await getCustomerTierMetrics(shop, customerId);
    const progressBeforeAward = buildTierProgress(settings, currentMetrics);
    const effectiveEarnRate = excludedCustomer ? 0 : computeEffectiveEarnRate(settings, progressBeforeAward.currentTier);
    const eligibleDollarUnits = Math.floor(eligibleNetCents / 100);
    const computedPoints = excludedCustomer ? 0 : Math.max(0, eligibleDollarUnits * effectiveEarnRate);

    await db.$transaction(async (tx) => {
      await tx.orderPointsSnapshot.create({
        data: {
          shop,
          orderId,
          orderName,
          customerId,
          eligibleNetMerchandise: eligibleNetCents,
          pointsAwarded: computedPoints,
          pointsReversedToDate: 0,
          effectiveTierId: progressBeforeAward.currentTier.tierId,
          effectiveTierName: progressBeforeAward.currentTier.name,
          effectiveEarnRate,
          paidAt,
          cancelledAt: null,
          discountCodesJson: null,
          createdAt: paidAt,
          updatedAt: paidAt,
        } as any,
      } as any);

      if (!excludedCustomer) {
        await applyBalanceDelta(tx, shop, customerId, 0, { activityAt: paidAt });
      }

      if (computedPoints > 0) {
        await tx.pointsLedger.create({
          data: {
            shop,
            customerId,
            type: LedgerType.EARN,
            delta: computedPoints,
            source: "ORDER",
            sourceId: orderId,
            description: `Historical backfill: earned ${computedPoints} point(s) from order ${orderName} as ${progressBeforeAward.currentTier.name}.`,
            createdAt: paidAt,
          },
        });

        await applyBalanceDelta(tx, shop, customerId, computedPoints, { incEarned: computedPoints, activityAt: paidAt });
        await refreshCustomerTierSnapshot(shop, customerId, tx);
      }
    });

    snapshot = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } } });
    if (computedPoints > 0) {
      awarded = 1;
      pointsAwarded = computedPoints;
    } else {
      skipped += 1;
    }
  }

  if (!snapshot) {
    return { scanned: 1, awarded, skipped: skipped + 1, pointsAwarded, refundsProcessed, cancellationsProcessed };
  }

  if (snapshot.pointsAwarded > 0) {
    for (const refundNode of orderNode?.refunds ?? []) {
      const refundId = numericIdFromShopifyId(refundNode?.id);
      if (!refundId) continue;

      const already = await db.pointsLedger.findFirst({
        where: { shop, type: LedgerType.REVERSAL, source: "REFUND", sourceId: refundId },
        select: { id: true },
      });
      if (already) continue;

      const freshSnapshot = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } } });
      if (!freshSnapshot || freshSnapshot.pointsAwarded <= 0) continue;

      const remaining = Math.max(0, freshSnapshot.pointsAwarded - freshSnapshot.pointsReversedToDate);
      if (remaining <= 0) continue;

      const eligibleRefundCents = computeEligibleRefundCents(refundNode, settings);
      if (eligibleRefundCents <= 0 || freshSnapshot.eligibleNetMerchandise <= 0) continue;

      const baseUnits = Math.floor(freshSnapshot.eligibleNetMerchandise / 100);
      const refundUnits = Math.floor(eligibleRefundCents / 100);
      const perDollar = baseUnits > 0 ? freshSnapshot.pointsAwarded / baseUnits : 0;
      const pointsToReverse = Math.min(remaining, Math.max(0, Math.floor(refundUnits * perDollar + 1e-9)));
      if (pointsToReverse <= 0) continue;

      const refundAt = refundNode?.createdAt ? new Date(refundNode.createdAt) : paidAt;

      await db.$transaction(async (tx) => {
        await tx.pointsLedger.create({
          data: {
            shop,
            customerId,
            type: LedgerType.REVERSAL,
            delta: -pointsToReverse,
            source: "REFUND",
            sourceId: refundId,
            description: `Historical backfill: reversed ${pointsToReverse} point(s) due to refund ${refundId}.`,
            createdAt: refundAt,
          },
        });

        await applyBalanceDelta(tx, shop, customerId, -pointsToReverse, { activityAt: refundAt });
        await refreshCustomerTierSnapshot(shop, customerId, tx);
        await tx.orderPointsSnapshot.update({
          where: { shop_orderId: { shop, orderId } },
          data: { pointsReversedToDate: { increment: pointsToReverse }, updatedAt: refundAt } as any,
        } as any);
      });

      refundsProcessed += 1;
    }
  }

  if (cancelledAt) {
    const alreadyCancelled = await db.pointsLedger.findFirst({
      where: { shop, type: LedgerType.REVERSAL, source: "CANCEL", sourceId: orderId },
      select: { id: true },
    });

    const freshSnapshot = await db.orderPointsSnapshot.findUnique({ where: { shop_orderId: { shop, orderId } } });
    const remaining = freshSnapshot ? Math.max(0, freshSnapshot.pointsAwarded - freshSnapshot.pointsReversedToDate) : 0;

    if (!alreadyCancelled && freshSnapshot && freshSnapshot.pointsAwarded > 0 && remaining > 0) {
      await db.$transaction(async (tx) => {
        await tx.pointsLedger.create({
          data: {
            shop,
            customerId,
            type: LedgerType.REVERSAL,
            delta: -remaining,
            source: "CANCEL",
            sourceId: orderId,
            description: `Historical backfill: reversed ${remaining} point(s) due to order cancellation.`,
            createdAt: cancelledAt,
          },
        });

        await applyBalanceDelta(tx, shop, customerId, -remaining, { activityAt: cancelledAt });
        await refreshCustomerTierSnapshot(shop, customerId, tx);
        await tx.orderPointsSnapshot.update({
          where: { shop_orderId: { shop, orderId } },
          data: { pointsReversedToDate: freshSnapshot.pointsAwarded, cancelledAt, updatedAt: cancelledAt } as any,
        } as any);
      });

      cancellationsProcessed += 1;
    } else if (freshSnapshot && !freshSnapshot.cancelledAt) {
      await db.orderPointsSnapshot.update({
        where: { shop_orderId: { shop, orderId } },
        data: { cancelledAt, updatedAt: cancelledAt } as any,
      } as any);
    }
  }

  return { scanned: 1, awarded, skipped, pointsAwarded, refundsProcessed, cancellationsProcessed };
}

export async function runHistoricalOrderBackfill(args: {
  shop: string;
  startDate: string;
  requestedBy?: string | null;
  persistConfiguration?: boolean;
}): Promise<HistoricalBackfillSummary> {
  const settings = await getOrCreateShopSettings(args.shop);
  const startDate = dayStartUtc(args.startDate);
  const throughDate = dayEndUtc(new Date());
  const accessToken = await getOfflineAccessToken(args.shop);
  if (!accessToken) throw new Error("Missing offline access token for shop. Reinstall/re-auth the app.");

  const run = await (db as any).historicalBackfillRun.create({
    data: {
      shop: args.shop,
      requestedBy: args.requestedBy ?? null,
      startDate,
      throughDate,
      status: "RUNNING",
    },
  });

  const adminGraphql = makeAdminGraphql(args.shop, accessToken);
  const query = `status:any created_at:>=${dateOnly(startDate)} created_at:<=${dateOnly(throughDate)}`;

  let after: string | null = null;
  const counters = {
    ordersScanned: 0,
    awardedOrders: 0,
    skippedOrders: 0,
    pointsAwarded: 0,
    refundsProcessed: 0,
    cancellationsProcessed: 0,
    errorCount: 0,
    lastError: null as string | null,
  };

  try {
    while (true) {
      const data = await adminGraphql(HISTORICAL_ORDERS_QUERY, { query, after });
      const edges = data?.orders?.edges ?? [];
      const pageInfo = data?.orders?.pageInfo ?? { hasNextPage: false, endCursor: null };

      for (const edge of edges) {
        const node = edge?.node;
        if (!node) continue;
        const result = await processHistoricalOrder(args.shop, settings, node);
        counters.ordersScanned += result.scanned;
        counters.awardedOrders += result.awarded;
        counters.skippedOrders += result.skipped;
        counters.pointsAwarded += result.pointsAwarded;
        counters.refundsProcessed += result.refundsProcessed;
        counters.cancellationsProcessed += result.cancellationsProcessed;
      }

      if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
      after = String(pageInfo.endCursor);
    }

    const completedAt = new Date();
    const summaryPayload = {
      startDate: startDate.toISOString(),
      throughDate: throughDate.toISOString(),
      ordersScanned: counters.ordersScanned,
      awardedOrders: counters.awardedOrders,
      skippedOrders: counters.skippedOrders,
      pointsAwarded: counters.pointsAwarded,
      refundsProcessed: counters.refundsProcessed,
      cancellationsProcessed: counters.cancellationsProcessed,
      errorCount: counters.errorCount,
      lastError: counters.lastError,
    };

    await (db as any).historicalBackfillRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        ordersScanned: counters.ordersScanned,
        awardedOrders: counters.awardedOrders,
        skippedOrders: counters.skippedOrders,
        pointsAwarded: counters.pointsAwarded,
        refundsProcessed: counters.refundsProcessed,
        cancellationsProcessed: counters.cancellationsProcessed,
        errorCount: counters.errorCount,
        lastError: counters.lastError,
        completedAt,
      },
    });

    await upsertShopSettings(args.shop, {
      historicalBackfillEnabled: args.persistConfiguration ?? settings.historicalBackfillEnabled,
      historicalBackfillStartDate: startDate.toISOString(),
      historicalBackfillLastRunAt: completedAt.toISOString(),
      historicalBackfillLastStatus: "COMPLETED",
      historicalBackfillLastSummary: summaryPayload,
    } as any);

    return {
      runId: String(run.id),
      shop: args.shop,
      startDate: startDate.toISOString(),
      throughDate: throughDate.toISOString(),
      ordersScanned: counters.ordersScanned,
      awardedOrders: counters.awardedOrders,
      skippedOrders: counters.skippedOrders,
      pointsAwarded: counters.pointsAwarded,
      refundsProcessed: counters.refundsProcessed,
      cancellationsProcessed: counters.cancellationsProcessed,
      errorCount: counters.errorCount,
      lastError: counters.lastError,
      completedAt: completedAt.toISOString(),
    };
  } catch (error: any) {
    const completedAt = new Date();
    const lastError = String(error?.message ?? error ?? "Unknown backfill error");

    await (db as any).historicalBackfillRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        ordersScanned: counters.ordersScanned,
        awardedOrders: counters.awardedOrders,
        skippedOrders: counters.skippedOrders,
        pointsAwarded: counters.pointsAwarded,
        refundsProcessed: counters.refundsProcessed,
        cancellationsProcessed: counters.cancellationsProcessed,
        errorCount: counters.errorCount + 1,
        lastError,
        completedAt,
      },
    });

    await upsertShopSettings(args.shop, {
      historicalBackfillEnabled: args.persistConfiguration ?? settings.historicalBackfillEnabled,
      historicalBackfillStartDate: startDate.toISOString(),
      historicalBackfillLastRunAt: completedAt.toISOString(),
      historicalBackfillLastStatus: "FAILED",
      historicalBackfillLastSummary: {
        startDate: startDate.toISOString(),
        throughDate: throughDate.toISOString(),
        ordersScanned: counters.ordersScanned,
        awardedOrders: counters.awardedOrders,
        skippedOrders: counters.skippedOrders,
        pointsAwarded: counters.pointsAwarded,
        refundsProcessed: counters.refundsProcessed,
        cancellationsProcessed: counters.cancellationsProcessed,
        errorCount: counters.errorCount + 1,
        lastError,
      },
    } as any);

    throw error;
  }
}
