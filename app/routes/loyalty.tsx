import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";
import { getShopSettings } from "../lib/shopSettings.server";

type LedgerRow = {
  id: string;
  type: string;
  delta: number;
  description: string | null;
  createdAt: string;
  runningBalance: number;
};

type RedemptionRow = {
  id: string;
  points: number;
  value: number;
  code: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  appliedAt: string | null;
  consumedAt: string | null;
};

type LoaderData = {
  ok: boolean;
  shop: string;
  customerId: string;

  // eligibility
  customerExcluded: boolean;
  customerExcludedReason: string | null;
  tagCheckWarning: string | null;

  // balances
  balance: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  lastActivityAt: string | null;
  estimatedExpiryAt: string | null; // lastActivityAt + 12 months

  // dashboard
  ledger: LedgerRow[];
  redemptions: RedemptionRow[];
  activeRedemption: RedemptionRow | null;

  // rules
  redemptionMinOrder: number;
  redemptionSteps: number[];
  redemptionValueMap: Record<string, number>;
  expiryMonths: number; // 12
};

type ActionData =
  | {
      ok: true;
      code: string;
      value: number;
      points: number;
      note?: string;
    }
  | { ok: false; error: string };

function verifyAppProxyHmac(url: URL, secret: string): boolean {
  // Shopify app proxy uses all query params except 'signature'
  const signature = url.searchParams.get("signature") ?? "";
  if (!signature) return false;

  const sorted = [...url.searchParams.entries()]
    .filter(([k]) => k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b));

  const message = sorted.map(([k, v]) => `${k}=${v}`).join("");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");

  // timing safe compare
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function formatDateTime(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function clampInt(n: any, min: number, max: number): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function computeLedgerWithRunningBalance(currentBalance: number, descRows: any[]): LedgerRow[] {
  // ledger rows are returned in descending createdAt order
  // compute running balance backwards
  let running = currentBalance;
  const out: LedgerRow[] = [];

  for (const row of descRows) {
    out.push({
      id: row.id,
      type: String(row.type),
      delta: Number(row.delta) || 0,
      description: row.description ?? null,
      createdAt: row.createdAt.toISOString(),
      runningBalance: running,
    });
    running -= Number(row.delta) || 0;
  }
  return out;
}

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const s = await db.session.findUnique({ where: { id } }).catch(() => null);
  return s?.accessToken ?? null;
}

async function shopifyGraphql(shop: string, query: string, variables: any) {
  const token = await getOfflineAccessToken(shop);
  if (!token) throw new Error("Missing offline access token for shop. Reinstall/re-auth the app.");

  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION ?? "2026-01";
  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json().catch(() => ({} as any));

  if (!resp.ok) throw new Error(`Shopify GraphQL HTTP ${resp.status}: ${JSON.stringify(json)}`);
  if (json.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);

  return json.data;
}

async function getEligibleProductGidsByTags(
  shop: string,
  includeTags: string[],
  excludeTags: string[],
): Promise<string[] | null> {
  const includes = includeTags.map((t) => t.trim()).filter(Boolean);
  const excludes = excludeTags.map((t) => t.trim()).filter(Boolean);

  // If no include/exclude constraints, allow all products
  if (includes.length === 0 && excludes.length === 0) return null;

  // Build Shopify product search query
  // - includes: tag:"A" OR tag:"B"
  // - excludes: -tag:"X" -tag:"Y"
  const includeQ = includes.length ? includes.map((t) => `tag:${JSON.stringify(t)}`).join(" OR ") : "";
  const excludeQ = excludes.length ? excludes.map((t) => `-tag:${JSON.stringify(t)}`).join(" ") : "";
  const q = [includeQ ? `(${includeQ})` : "", excludeQ].filter(Boolean).join(" ").trim();

  const query = `
    query ProductsByTags($q: String!, $cursor: String) {
      products(first: 250, query: $q, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  `;

  const ids: string[] = [];
  let cursor: string | null = null;
  let loops = 0;

  while (loops < 50) {
    loops++;
    const data = await shopifyGraphql(shop, query, { q, cursor });
    const page = data?.products;
    const nodes: any[] = page?.nodes ?? [];
    for (const n of nodes) {
      const id = String(n?.id ?? "");
      if (id) ids.push(id);
    }
    const hasNext = Boolean(page?.pageInfo?.hasNextPage);
    const endCursor = page?.pageInfo?.endCursor ? String(page.pageInfo.endCursor) : null;
    if (!hasNext || !endCursor) break;
    cursor = endCursor;
  }

  // If we couldn't enumerate any products under a restrictive query, return empty array
  // so callers can decide whether to fail closed or open.
  return ids.length ? ids : [];
}

function makeDiscountCode(prefix = "REWARDS") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = prefix + "-";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function createShopifyDiscountCode({
  shop,
  customerGid,
  amountOff,
  minSubtotal,
  eligibleProductIds,
  title,
  code,
  startsAt,
  endsAt,
}: {
  shop: string;
  customerGid: string;
  amountOff: number;
  minSubtotal: number;
  eligibleProductIds: string[] | null;
  title: string;
  code: string;
  startsAt: string;
  endsAt: string;
}) {
  const mutation = `
    mutation CreateDiscountCode($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic { title codes(first: 5) { nodes { code } } }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const customerSelection = { customers: { add: [customerGid] } };

  const customerGets = {
    items: eligibleProductIds && eligibleProductIds.length > 0 ? { products: { productsToAdd: eligibleProductIds } } : { all: true },
    value: { discountAmount: { amount: amountOff, appliesOnEachItem: false } },
  };

  const minimumRequirement =
    minSubtotal > 0 ? { subtotal: { greaterThanOrEqualToSubtotal: String(minSubtotal.toFixed(2)) } } : null;

  const basicCodeDiscount: any = {
    title,
    code,
    startsAt,
    endsAt,
    customerSelection,
    customerGets,
    appliesOncePerCustomer: true,
    usageLimit: 1,
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
  };

  if (minimumRequirement) basicCodeDiscount.minimumRequirement = minimumRequirement;

  const data = await shopifyGraphql(shop, mutation, { basicCodeDiscount });

  const result = data?.discountCodeBasicCreate;
  const errs: any[] = result?.userErrors ?? [];
  if (errs.length) throw new Error(`Discount create errors: ${JSON.stringify(errs)}`);

  const node = result?.codeDiscountNode;
  const createdCode = node?.codeDiscount?.codes?.nodes?.[0]?.code ?? code;
  return { nodeId: node?.id ?? null, code: createdCode };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";

  const shop = (url.searchParams.get("shop") ?? "").toLowerCase();
  const customerId = url.searchParams.get("logged_in_customer_id") ?? "";
  const ok = verifyAppProxyHmac(url, apiSecret);

  if (!ok || !shop || !customerId) {
    return data<LoaderData>(
      {
        ok: false,
        shop,
        customerId,
        customerExcluded: false,
        customerExcludedReason: null,
        tagCheckWarning: null,
        balance: 0,
        lifetimeEarned: 0,
        lifetimeRedeemed: 0,
        lastActivityAt: null,
        estimatedExpiryAt: null,
        ledger: [],
        redemptions: [],
        activeRedemption: null,
        redemptionMinOrder: 0,
        redemptionSteps: [],
        redemptionValueMap: {},
        expiryMonths: 12,
      },
      { status: 401 },
    );
  }

  const expiryMonths = 12;
  const settings = await getShopSettings(shop);

  const customerGid = await getCustomerGid(shop, customerId);
  const tagResult = await getCustomerTags(shop, customerGid);
  const customerTags = tagResult.tags;
  const excludedTagList = settings.excludedCustomerTags ?? [];
  const customerExcluded = excludedTagList.some((t) => customerTags.includes(t));
  const customerExcludedReason = customerExcluded
    ? `Excluded customer tag: ${excludedTagList.find((t) => customerTags.includes(t))}`
    : null;
  const tagCheckWarning = tagResult.warning ?? null;

  const bal = await db.customerPointsBalance
    .findUnique({ where: { shop_customerId: { shop, customerId } } })
    .catch(() => null);

  const balance = bal?.balance ?? 0;
  const lifetimeEarned = bal?.lifetimeEarned ?? 0;
  const lifetimeRedeemed = bal?.lifetimeRedeemed ?? 0;

  const lastActivityAt = bal?.lastActivityAt ? bal.lastActivityAt.toISOString() : null;
  const estimatedExpiryAt =
    bal?.lastActivityAt ? addMonths(new Date(bal.lastActivityAt), expiryMonths).toISOString() : null;

  const ledgerDesc = await db.pointsLedger.findMany({
    where: { shop, customerId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, type: true, delta: true, description: true, createdAt: true },
  });

  const ledger = computeLedgerWithRunningBalance(balance, ledgerDesc);

  const redemptionsDesc = await db.redemption.findMany({
    where: { shop, customerId },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      id: true,
      points: true,
      value: true,
      code: true,
      status: true,
      createdAt: true,
      expiresAt: true,
      appliedAt: true,
      consumedAt: true,
    },
  });

  const redemptions: RedemptionRow[] = redemptionsDesc.map((r) => ({
    id: r.id,
    points: (r as any).points ?? (r as any).pointsSpent ?? 0,
    value: r.value,
    code: r.code,
    status: String(r.status),
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    appliedAt: (r as any).appliedAt ? (r as any).appliedAt.toISOString() : null,
    consumedAt: (r as any).consumedAt ? (r as any).consumedAt.toISOString() : null,
  }));

  const activeRedemption =
    redemptions.find((r) => r.status === "ISSUED" || r.status === "APPLIED") ?? null;

  return data<LoaderData>({
    ok: true,
    shop,
    customerId,
    customerExcluded,
    customerExcludedReason,
    tagCheckWarning,
    balance,
    lifetimeEarned,
    lifetimeRedeemed,
    lastActivityAt,
    estimatedExpiryAt,
    ledger,
    redemptions,
    activeRedemption,
    redemptionMinOrder: Number(settings.redemptionMinOrder ?? 0) || 0,
    redemptionSteps: (settings.redemptionSteps as any) ?? [],
    redemptionValueMap: (settings.redemptionValueMap as any) ?? {},
    expiryMonths,
  });
};

async function getCustomerGid(shop: string, customerId: string): Promise<string> {
  // customerId from app proxy is numeric; build GID.
  const numeric = String(customerId).trim();
  if (!numeric) throw new Error("Missing customerId.");
  // Shopify Admin GraphQL GID for Customer:
  return `gid://shopify/Customer/${numeric}`;
}

async function getCustomerTags(shop: string, customerGid: string): Promise<{ tags: string[]; warning?: string | null }> {
  const query = `
    query CustomerTags($id: ID!) {
      customer(id: $id) { tags }
    }
  `;
  try {
    const data = await shopifyGraphql(shop, query, { id: customerGid });
    const tags: any[] = data?.customer?.tags ?? [];
    return { tags: Array.isArray(tags) ? tags.map((t) => String(t)) : [] };
  } catch (e: any) {
    return { tags: [], warning: String(e?.message ?? e) };
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";

  const shop = (url.searchParams.get("shop") ?? "").toLowerCase();
  const customerId = url.searchParams.get("logged_in_customer_id") ?? "";
  const ok = verifyAppProxyHmac(url, apiSecret);

  if (!ok || !shop || !customerId) {
    return data<ActionData>({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent !== "redeem") {
    return data<ActionData>({ ok: false, error: "Unknown action." }, { status: 400 });
  }

  const settings = await getShopSettings(shop);

  const customerGid = await getCustomerGid(shop, customerId);
  const tagResult = await getCustomerTags(shop, customerGid);
  const customerTags = tagResult.tags;
  const excludedTagList = settings.excludedCustomerTags ?? [];
  const customerExcluded = excludedTagList.some((t) => customerTags.includes(t));
  if (customerExcluded) {
    return data<ActionData>({ ok: false, error: "This account is not eligible for rewards." }, { status: 403 });
  }

  const pointsReqRaw = Number(form.get("points") ?? 0) || 0;
  const pointsReq = clampInt(pointsReqRaw, 1, 1_000_000);

  if (![500, 1000].includes(pointsReq)) {
    return data<ActionData>({ ok: false, error: "Invalid reward tier. Choose 500 or 1000 points." }, { status: 400 });
  }

  const redemptionValueMap = (settings.redemptionValueMap as any) ?? {};
  const amountOff = Number(redemptionValueMap[String(pointsReq)] ?? 0) || 0;

  if (amountOff <= 0) {
    return data<ActionData>({ ok: false, error: "Invalid redemption tier." }, { status: 400 });
  }

  // Only one active redemption allowed
  const active = await db.redemption.findFirst({
    where: { shop, customerId, status: { in: ["ISSUED", "APPLIED"] } },
    select: { code: true, value: true, points: true, status: true },
  });

  if (active) {
    return data<ActionData>({
      ok: true,
      code: active.code,
      value: active.value,
      points: (active as any).points ?? pointsReq,
      note: "You already have an active code.",
    });
  }

  // Load balance
  const bal = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });

  const balance = bal?.balance ?? 0;

  if (balance < pointsReq) {
    return data<ActionData>({ ok: false, error: "Not enough points." }, { status: 400 });
  }

  // Idempotency: use idemKey (posted from UI) to avoid double issuance
  const idemKey = String(form.get("idemKey") ?? "");
  if (!idemKey) return data<ActionData>({ ok: false, error: "Missing idempotency key." }, { status: 400 });

  const existingIdem = await db.redemption.findFirst({
    where: { shop, customerId, idempotencyKey: idemKey },
    select: { code: true, value: true, points: true, status: true },
  });

  if (existingIdem) {
    return data<ActionData>({
      ok: true,
      code: existingIdem.code,
      value: existingIdem.value,
      points: (existingIdem as any).points ?? (existingIdem as any).pointsSpent ?? pointsReq,
      note: "Request already processed (idempotent).",
    });
  }

  const code = makeDiscountCode("REWARDS");
  const title = `Lions Creek Rewards - $${Math.round(amountOff)} off`;

  // customerGid resolved above

  const eligibleProducts = await getEligibleProductGidsByTags(shop, settings.includeProductTags, settings.excludeProductTags);

  const hasProductConstraints = settings.includeProductTags.length > 0 || settings.excludeProductTags.length > 0;
  if (hasProductConstraints && Array.isArray(eligibleProducts) && eligibleProducts.length === 0) {
    return data<ActionData>(
      { ok: false, error: "Rewards are not configured for any eligible products right now." },
      { status: 400 },
    );
  }

  const minSubtotal = Number(settings.redemptionMinOrder ?? 0) || 0;

  // Create discount code in Shopify + issue redemption atomically with ledger/balance updates
  const created = await createShopifyDiscountCode({
    shop,
    customerGid,
    amountOff,
    minSubtotal,
    eligibleProductIds: eligibleProducts,
    title,
    code,
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
  });

  await db.$transaction(async (tx) => {
    // Deduct points (ledger)
    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: "REDEEM",
        delta: -pointsReq,
        description: `Redeemed ${pointsReq} points for $${Math.round(amountOff)} off code ${created.code}`,
        orderId: null,
        orderName: null,
      },
    });

    // Update balance
    await tx.customerPointsBalance.upsert({
      where: { shop_customerId: { shop, customerId } },
      create: {
        shop,
        customerId,
        balance: Math.max(0, balance - pointsReq),
        lifetimeEarned: 0,
        lifetimeRedeemed: pointsReq,
        lastActivityAt: new Date(),
      },
      update: {
        balance: { decrement: pointsReq },
        lifetimeRedeemed: { increment: pointsReq },
        lastActivityAt: new Date(),
      },
    });

    // Create redemption record
    await tx.redemption.create({
      data: {
        shop,
        customerId,
        points: pointsReq,
        value: amountOff,
        code: created.code,
        status: "ISSUED",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        shopifyDiscountId: created.nodeId,
        idempotencyKey: idemKey,
      } as any,
    });
  });

  return data<ActionData>({
    ok: true,
    code: created.code,
    value: amountOff,
    points: pointsReq,
  });
};

export default function LoyaltyPage() {
  const d = useLoaderData<typeof loader>() as LoaderData;
  const actionData = useActionData<ActionData>();

  if (!d.ok) {
    return (
      <main style={{ fontFamily: "system-ui, sans-serif", padding: 18 }}>
        <h1 style={{ marginTop: 0 }}>Rewards</h1>
        <p style={{ opacity: 0.8 }}>Unable to load rewards for this session.</p>
      </main>
    );
  }

  const stepsSorted = [...(d.redemptionSteps ?? [])].sort((a, b) => a - b);
  const idemKey = crypto.randomBytes(16).toString("hex");
  const active = d.activeRedemption;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 18, maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>Lions Creek Rewards</h1>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Your points</h2>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "baseline" }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Balance</div>
            <div style={{ fontSize: 34, fontWeight: 800 }}>{d.balance}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Lifetime earned</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{d.lifetimeEarned}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Lifetime redeemed</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{d.lifetimeRedeemed}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Last activity</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{d.lastActivityAt ? formatDateTime(d.lastActivityAt) : ""}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Estimated expiry</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {d.estimatedExpiryAt ? formatDateTime(d.estimatedExpiryAt) : ""}
            </div>
          </div>
        </div>
      </section>

      {actionData ? (
        <section
          style={{
            border: `1px solid ${actionData.ok ? "#b7e4c7" : "#ffccd5"}`,
            background: actionData.ok ? "#ecfdf5" : "#fff1f2",
            borderRadius: 12,
            padding: 14,
            marginBottom: 14,
          }}
        >
          {actionData.ok ? (
            <>
              <div style={{ fontWeight: 800, fontSize: 16 }}>Your code:</div>
              <div style={{ fontWeight: 900, fontSize: 26, marginTop: 6 }}>{actionData.code}</div>
              <div style={{ marginTop: 6, opacity: 0.85 }}>
                ${Math.round(actionData.value)} off — costs {actionData.points} points
              </div>
              {actionData.note ? <div style={{ marginTop: 6, opacity: 0.8 }}>{actionData.note}</div> : null}
            </>
          ) : (
            <div style={{ fontWeight: 700 }}>{actionData.error}</div>
          )}
        </section>
      ) : null}

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h3 style={{ marginTop: 0 }}>Redeem rewards</h3>

        <div style={{ fontSize: 14, opacity: 0.85, marginBottom: 10 }}>
          Redeem points for a one-time discount code. Codes expire in 7 days. Only one active code is allowed at a time.
          {d.redemptionMinOrder > 0 ? (
            <div style={{ marginTop: 6 }}>
              Minimum order subtotal to use a rewards code: <strong>${d.redemptionMinOrder.toFixed(2)}</strong>
            </div>
          ) : null}
        </div>

        {d.customerExcluded ? (
          <div style={{ border: "1px solid #fecaca", background: "#fff1f2", padding: 12, borderRadius: 12, marginBottom: 12 }}>
            <div style={{ fontWeight: 700 }}>Rewards are not available for this account.</div>
            {d.customerExcludedReason ? <div style={{ marginTop: 6, opacity: 0.85 }}>{d.customerExcludedReason}</div> : null}
          </div>
        ) : null}

        {d.tagCheckWarning ? (
          <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 10 }}>
            Note: customer tag eligibility could not be verified ({d.tagCheckWarning}).
          </div>
        ) : null}

        {d.customerExcluded ? null : active ? (
          <div style={{ border: "1px solid #d9ead3", background: "#f4fbf4", borderRadius: 12, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 13, opacity: 0.75 }}>Your active code</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{active.code}</div>
            <div style={{ marginTop: 6, fontSize: 14 }}>
              ${Math.round(active.value)} off ({active.points} points)
              {active.expiresAt ? (
                <>
                  {" "}
                  • Expires <strong>{formatDateTime(active.expiresAt)}</strong>
                </>
              ) : null}
            </div>
            <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
              Enter this code at checkout. If you don’t use it, it will expire automatically.
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
            {stepsSorted.map((pts) => {
              const val = Number(d.redemptionValueMap[String(pts)] ?? 0) || 0;
              const disabled = d.balance < pts || val <= 0;

              return (
                <Form method="post" key={pts}>
                  <input type="hidden" name="intent" value="redeem" />
                  <input type="hidden" name="points" value={String(pts)} />
                  <input type="hidden" name="idemKey" value={idemKey} />
                  <button
                    type="submit"
                    disabled={disabled}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 12,
                      border: "1px solid #ddd",
                      cursor: disabled ? "not-allowed" : "pointer",
                      fontWeight: 700,
                    }}
                  >
                    {pts} pts → ${Math.round(val)} off
                  </button>
                </Form>
              );
            })}
          </div>
        )}
      </section>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
        <h3 style={{ marginTop: 0 }}>Recent points activity</h3>

        {d.ledger.length === 0 ? (
          <p style={{ margin: 0, opacity: 0.8 }}>No points history yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Date</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Type</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Description</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Delta</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {d.ledger.map((row) => (
                <tr key={row.id}>
                  <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>{formatDateTime(row.createdAt)}</td>
                  <td style={{ padding: "8px 0", fontWeight: 700 }}>{row.type}</td>
                  <td style={{ padding: "8px 0", opacity: 0.9 }}>{row.description ?? ""}</td>
                  <td style={{ padding: "8px 0", textAlign: "right" }}>{row.delta}</td>
                  <td style={{ padding: "8px 0", textAlign: "right" }}>{row.runningBalance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginTop: 14, fontSize: 13, opacity: 0.75 }}>
        <strong>How to earn points:</strong> points are earned on eligible net merchandise spend (after discounts), and may be reversed on refunds/cancellations.
      </section>
    </main>
  );
}
