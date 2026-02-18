import db from "../db.server";
import { apiVersion } from "../shopify.server";
import { RedemptionStatus } from "@prisma/client";
import { getOrCreateShopSettings } from "./shopSettings.server";
import { fetchCustomerTags, resolveEligibleCollectionGid, type AdminGraphql } from "./shopifyQueries.server";

export type IssueRedemptionArgs = {
  shop: string;
  customerId: string;
  pointsRequested: number;
  idempotencyKey?: string;
};

export type IssueRedemptionResult =
  | { ok: true; code: string; expiresAt: string; pointsDebited: number; valueDollars: number; idempotencyKey?: string }
  | { ok: false; error: string };

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const sess = await db.session.findUnique({ where: { id } }).catch(() => null);
  return sess?.accessToken ?? null;
}

function makeAdminGraphql(shop: string, accessToken: string): AdminGraphql {
  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  return async (query: string, args?: { variables?: Record<string, any> }) => {
    return fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables: args?.variables ?? {} }),
    });
  };
}

async function graphqlJson(res: Response): Promise<any> {
  const text = await res.text().catch(() => "");
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) throw new Error(`Shopify GraphQL failed: ${res.status} ${res.statusText} ${text}`);
  if (json?.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json?.data ?? null;
}

function normalizeCustomerId(raw: string): string {
  if (!raw) return "";
  const s = String(raw).trim();
  const m = s.match(/Customer\/(\d+)/i);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;
  return s;
}

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "LCR-";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function uniqueCode(shop: string): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = generateCode();
    const exists = await db.redemption.findFirst({ where: { shop, code }, select: { id: true } });
    if (!exists) return code;
  }
  return `${generateCode()}-${Math.floor(Math.random() * 9)}`;
}

const DISCOUNT_CREATE = `#graphql
mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode { id }
    userErrors { field message }
  }
}
`;

async function createDiscount(
  adminGraphql: AdminGraphql,
  args: { code: string; valueDollars: number; endsAt: Date; eligibleCollectionGid: string },
): Promise<{ ok: true; discountNodeId: string } | { ok: false; error: string }> {
  const variables = {
    basicCodeDiscount: {
      title: `LCR Redemption ${args.code}`,
      code: args.code,
      startsAt: new Date().toISOString(),
      endsAt: args.endsAt.toISOString(),
      usageLimit: 1,
      customerSelection: { all: true },
      combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
      customerGets: {
        value: { discountAmount: { amount: String(args.valueDollars), appliesOnEachItem: false } },
        items: { collections: { add: [args.eligibleCollectionGid] } },
      },
    },
  };

  const data = await graphqlJson(await adminGraphql(DISCOUNT_CREATE, { variables }));
  const result = data?.discountCodeBasicCreate;
  const errs = result?.userErrors ?? [];
  if (errs.length) return { ok: false, error: errs.map((e: any) => e?.message).join("; ") };

  const id = result?.codeDiscountNode?.id;
  if (!id) return { ok: false, error: "Missing codeDiscountNode.id" };
  return { ok: true, discountNodeId: String(id) };
}

export async function issueRedemptionCode(args: IssueRedemptionArgs): Promise<IssueRedemptionResult> {
  const shop = String(args.shop || "").trim();
  const customerId = normalizeCustomerId(args.customerId);
  const pointsRequested = Number(args.pointsRequested);
  const idemKey = args.idempotencyKey ? String(args.idempotencyKey).trim() : undefined;

  if (!shop) return { ok: false, error: "Missing shop" };
  if (!customerId) return { ok: false, error: "Missing customerId" };
  if (!Number.isInteger(pointsRequested) || pointsRequested <= 0) return { ok: false, error: "Invalid points" };

  const settings = await getOrCreateShopSettings(shop);

  if (!settings.redemptionSteps.includes(pointsRequested)) {
    return { ok: false, error: `Points must be one of: ${settings.redemptionSteps.join(", ")}` };
  }

  const valueDollars = Number(settings.redemptionValueMap[String(pointsRequested)]);
  if (!Number.isFinite(valueDollars) || valueDollars <= 0) return { ok: false, error: "Invalid redemption map" };

  // Idempotency
  if (idemKey) {
    const existing = await db.redemption.findUnique({
      where: { redemption_idem: { shop, customerId, idemKey } },
      select: { code: true, expiresAt: true, points: true, valueDollars: true },
    });
    if (existing) {
      return {
        ok: true,
        code: existing.code,
        expiresAt: existing.expiresAt ? existing.expiresAt.toISOString() : new Date().toISOString(),
        pointsDebited: existing.points,
        valueDollars: existing.valueDollars,
        idempotencyKey: idemKey,
      };
    }
  }

  // Active redemption guard
  const active = await db.redemption.findFirst({
    where: {
      shop,
      customerId,
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { code: true },
  });
  if (active) return { ok: false, error: "Active redemption already exists" };

  const token = await getOfflineAccessToken(shop);
  if (!token) return { ok: false, error: `Missing offline token for ${shop}` };
  const adminGraphql = makeAdminGraphql(shop, token);

  // Excluded customer tags
  if (settings.excludedCustomerTags.length) {
    const tags = await fetchCustomerTags(adminGraphql, customerId);
    const lower = new Set(tags.map((t) => t.toLowerCase()));
    if (settings.excludedCustomerTags.some((t) => lower.has(String(t).toLowerCase()))) {
      return { ok: false, error: "Customer excluded from loyalty program" };
    }
  }

  const eligibleCollectionGid = await resolveEligibleCollectionGid(adminGraphql, shop, settings);

  // Balance check
  const bal = await db.customerPointsBalance.upsert({
    where: { shop_customerId: { shop, customerId } },
    create: { shop, customerId },
    update: {},
  });
  if (bal.balance < pointsRequested) return { ok: false, error: "Insufficient points" };

  const now = new Date();
  const expiresAt = new Date(now.getTime() + settings.redemptionExpiryHours * 60 * 60 * 1000);
  const code = await uniqueCode(shop);

  // Create discount first (dev-safe), then transactionally debit points + persist redemption.
  const discount = await createDiscount(adminGraphql, { code, valueDollars, endsAt: expiresAt, eligibleCollectionGid });
  if (!discount.ok) return { ok: false, error: discount.error };

  await db.$transaction(async (tx) => {
    await tx.customerPointsBalance.update({
      where: { shop_customerId: { shop, customerId } },
      data: {
        balance: { decrement: pointsRequested },
        lifetimeRedeemed: { increment: pointsRequested },
        lastActivityAt: now,
        expiredAt: null,
      },
    });

    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: "REDEEM",
        delta: -pointsRequested,
        source: "REDEMPTION",
        sourceId: code,
        description: `Issued redemption ${code} for $${valueDollars}`,
      },
    });

    await tx.redemption.create({
      data: {
        shop,
        customerId,
        status: RedemptionStatus.ISSUED,
        points: pointsRequested,
        valueDollars,
        code,
        discountNodeId: discount.discountNodeId,
        expiresAt,
        idemKey: idemKey ?? null,
      },
    });
  });

  return {
    ok: true,
    code,
    expiresAt: expiresAt.toISOString(),
    pointsDebited: pointsRequested,
    valueDollars,
    idempotencyKey: idemKey,
  };
}
