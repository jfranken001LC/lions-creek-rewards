// app/lib/redemption.server.ts
import crypto from "crypto";
import db from "../db.server";
import { LedgerType, RedemptionStatus } from "@prisma/client";
import { getShopSettings } from "./shopSettings.server";
import { fetchCustomerTags, resolveEligibleCollectionGid } from "./shopifyQueries.server";

type AdminClient = {
  graphql: (query: string, args?: { variables?: Record<string, any> }) => Promise<Response>;
};

const REDEMPTION_EXPIRY_HOURS = 72;

const DISCOUNT_CODE_BASIC_CREATE = `#graphql
  mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field code message }
    }
  }
`;

function normSet(list: string[]) {
  return new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * Normalize a Shopify customer identifier into the numeric ID string.
 * - Accepts: "gid://shopify/Customer/123", "123"
 * - Returns: "123"
 */
export function normalizeCustomerId(input: string): string {
  const s = String(input ?? "").trim();
  if (!s) return "";
  const m = s.match(/^gid:\/\/shopify\/Customer\/(\d+)$/);
  if (m?.[1]) return m[1];
  if (/^\d+$/.test(s)) return s;

  // Conservative fallback for rare formats containing the GID inside a larger string.
  const m2 = s.match(/gid:\/\/shopify\/Customer\/(\d+)/);
  if (m2?.[1]) return m2[1];

  return s;
}

export function toCustomerGid(customerId: string): string {
  const id = normalizeCustomerId(customerId);
  return `gid://shopify/Customer/${id}`;
}

export type IssueRedemptionResult = {
  redemptionId: string;
  code: string;
  discountNodeId: string;
  expiresAt: string;
  points: number;
  valueDollars: number;
};

export async function issueRedemptionCode(args: {
  shop: string;
  admin: AdminClient;

  /**
   * Prefer passing numeric ID string ("123").
   * Back-compat: customerGid is still accepted.
   */
  customerId?: string;
  customerGid?: string;

  pointsRequested: number;
  idemKey?: string | null;
  now?: Date;
}): Promise<IssueRedemptionResult> {
  const now = args.now ?? new Date();
  const idemKey = args.idemKey?.trim() ? args.idemKey.trim() : null;

  const customerId = normalizeCustomerId(args.customerId ?? args.customerGid ?? "");
  if (!customerId) throw new Error("Missing customerId");

  const settings = await getShopSettings(args.shop);

  if (!Number.isInteger(args.pointsRequested) || args.pointsRequested <= 0) {
    throw new Error("Invalid pointsRequested");
  }
  if (!settings.redemptionSteps.includes(args.pointsRequested)) {
    throw new Error(`Invalid redemption amount. Allowed: ${settings.redemptionSteps.join(", ")}`);
  }

  // Customer tag exclusions
  if (settings.excludedCustomerTags.length > 0) {
    const tags = await fetchCustomerTags(args.admin, toCustomerGid(customerId));
    const customer = normSet(tags);
    const excluded = normSet(settings.excludedCustomerTags);
    for (const t of excluded) {
      if (customer.has(t)) {
        throw new Error("Customer is not eligible for loyalty redemption.");
      }
    }
  }

  // Require eligible collection handle for redemption eligibility
  if (!settings.eligibleCollectionHandle?.trim()) {
    throw new Error("Eligible collection handle is not configured in Settings.");
  }

  const eligibleCollectionGid = await resolveEligibleCollectionGid({
    admin: args.admin,
    shop: args.shop,
    handle: settings.eligibleCollectionHandle,
  });

  // Idempotency key support (optional)
  if (idemKey) {
    const existing = await db.redemption.findFirst({
      where: { shop: args.shop, customerId, idemKey },
    });
    if (
      existing &&
      existing.status !== RedemptionStatus.VOID &&
      existing.expiresAt &&
      existing.expiresAt > now &&
      existing.discountNodeId
    ) {
      return {
        redemptionId: existing.id,
        code: existing.code,
        discountNodeId: existing.discountNodeId,
        expiresAt: existing.expiresAt.toISOString(),
        points: existing.points,
        valueDollars: existing.value,
      };
    }
  }

  // Only one active code at a time
  const active = await db.redemption.findFirst({
    where: {
      shop: args.shop,
      customerId,
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });
  if (active?.discountNodeId && active.expiresAt) {
    return {
      redemptionId: active.id,
      code: active.code,
      discountNodeId: active.discountNodeId,
      expiresAt: active.expiresAt.toISOString(),
      points: active.points,
      valueDollars: active.value,
    };
  }

  const valueDollars = Number(settings.redemptionValueMap[String(args.pointsRequested)] ?? 0);
  if (!valueDollars) throw new Error("Redemption value map misconfigured.");

  const code = `LCR-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const expiresAt = new Date(now.getTime() + REDEMPTION_EXPIRY_HOURS * 60 * 60 * 1000);

  // Phase 1: debit points + create local redemption + ledger
  const redemption = await db.$transaction(async (tx) => {
    const bal = await tx.customerPointsBalance.upsert({
      where: { shop_customerId: { shop: args.shop, customerId } },
      create: {
        shop: args.shop,
        customerId,
        balance: 0,
        lifetimeEarned: 0,
        lifetimeRedeemed: 0,
        lastActivityAt: now,
        expiredAt: null,
      },
      update: {},
    });

    if (bal.balance < args.pointsRequested) {
      throw new Error("Insufficient points");
    }

    const created = await tx.redemption.create({
      data: {
        shop: args.shop,
        customerId,
        points: args.pointsRequested,
        value: valueDollars,
        code,
        discountNodeId: null,
        idemKey,
        status: RedemptionStatus.ISSUED,
        issuedAt: now,
        expiresAt,
      },
    });

    await tx.pointsLedger.create({
      data: {
        shop: args.shop,
        customerId,
        type: LedgerType.REDEEM,
        delta: -args.pointsRequested,
        source: "REDEMPTION",
        sourceId: created.id,
        description: `Redeem ${args.pointsRequested} pts → $${valueDollars} off (code ${code})`,
      },
    });

    await tx.customerPointsBalance.update({
      where: { shop_customerId: { shop: args.shop, customerId } },
      data: {
        balance: { decrement: args.pointsRequested },
        lifetimeRedeemed: { increment: args.pointsRequested },
        lastActivityAt: now,
        expiredAt: null,
      },
    });

    return created;
  });

  // Phase 2: create Shopify discount code
  try {
    const discountNodeId = await createShopifyDiscountCode({
      admin: args.admin,
      code,
      customerId,
      valueDollars,
      minSubtotalDollars: settings.redemptionMinOrder,
      eligibleCollectionGid,
      endsAt: expiresAt,
    });

    const updated = await db.redemption.update({
      where: { id: redemption.id },
      data: { discountNodeId },
    });

    return {
      redemptionId: updated.id,
      code: updated.code,
      discountNodeId,
      expiresAt: updated.expiresAt!.toISOString(),
      points: updated.points,
      valueDollars: updated.value,
    };
  } catch (e: any) {
    // Compensating restore
    await voidAndRestore({
      shop: args.shop,
      customerId,
      redemptionId: redemption.id,
      points: args.pointsRequested,
      now,
      reason: `SHOPIFY_DISCOUNT_CREATE_FAILED: ${String(e?.message ?? e)}`,
    });
    throw e;
  }
}

async function createShopifyDiscountCode(args: {
  admin: AdminClient;
  code: string;
  customerId: string;
  valueDollars: number;
  minSubtotalDollars: number;
  eligibleCollectionGid: string;
  endsAt: Date;
}): Promise<string> {
  const money = (n: number) => n.toFixed(2);
  const customerGid = toCustomerGid(args.customerId);

  const variables = {
    basicCodeDiscount: {
      title: `Lions Creek Rewards $${args.valueDollars} off`,
      code: args.code,
      startsAt: new Date().toISOString(),
      endsAt: args.endsAt.toISOString(),
      customerSelection: { customers: { add: [customerGid] } },
      usageLimit: 1,
      appliesOncePerCustomer: true,
      customerGets: {
        items: { collections: { add: [args.eligibleCollectionGid] } },
        value: {
          discountAmount: {
            amount: money(args.valueDollars),
            appliesOnEachItem: false,
          },
        },
      },
      minimumRequirement:
        args.minSubtotalDollars > 0
          ? {
              subtotal: {
                greaterThanOrEqualToSubtotal: money(args.minSubtotalDollars),
              },
            }
          : null,
    },
  };

  const res = await args.admin.graphql(DISCOUNT_CODE_BASIC_CREATE, { variables });
  const json = (await res.json()) as any;
  const errs = json?.data?.discountCodeBasicCreate?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: any) => e.message).join("; "));
  const id = json?.data?.discountCodeBasicCreate?.codeDiscountNode?.id;
  if (!id) throw new Error("Discount creation failed (missing node id)");
  return String(id);
}

async function voidAndRestore(args: {
  shop: string;
  customerId: string;
  redemptionId: string;
  points: number;
  now: Date;
  reason: string;
}) {
  await db.$transaction(async (tx) => {
    const bal = await tx.customerPointsBalance.findUnique({
      where: { shop_customerId: { shop: args.shop, customerId: args.customerId } },
      select: { lifetimeRedeemed: true },
    });
    const nextLifetimeRedeemed = Math.max(0, (bal?.lifetimeRedeemed ?? 0) - args.points);

    await tx.redemption.update({
      where: { id: args.redemptionId },
      data: {
        status: RedemptionStatus.VOID,
        voidedAt: args.now,
        restoredAt: args.now,
        restoreReason: args.reason,
      },
    });

    await tx.pointsLedger.create({
      data: {
        shop: args.shop,
        customerId: args.customerId,
        type: LedgerType.ADJUST,
        delta: args.points,
        source: "REDEMPTION_VOID",
        sourceId: args.redemptionId,
        description: `Restore ${args.points} pts (void redemption). Reason: ${args.reason}`,
      },
    });

    await tx.customerPointsBalance.update({
      where: { shop_customerId: { shop: args.shop, customerId: args.customerId } },
      data: {
        balance: { increment: args.points },
        lifetimeRedeemed: nextLifetimeRedeemed,
        expiredAt: null,
      },
    });
  });
}
