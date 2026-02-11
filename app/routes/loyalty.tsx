import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";

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
  | { ok: false; error: string }
  | { ok: true; code: string; value: number; points: number; note?: string };

function timingSafeEqual(a: Buffer, b: Buffer) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyAppProxyHmac(url: URL, apiSecret: string): boolean {
  const hmac = url.searchParams.get("hmac");
  if (!hmac || !apiSecret) return false;

  // Shopify app proxy signature: sort params excluding hmac/signature, join k=v with &
  const pairs: string[] = [];
  const keys = Array.from(url.searchParams.keys())
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort();

  for (const k of keys) {
    const values = url.searchParams.getAll(k);
    for (const v of values) pairs.push(`${k}=${v}`);
  }

  const message = pairs.join("&");
  const digest = crypto.createHmac("sha256", apiSecret).update(message).digest("hex");
  return timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmac, "utf8"));
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
    s = JSON.stringify({ error: "Could not stringify." });
  }
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);

  // handle month rollover (e.g., Jan 31 + 1 month)
  if (d.getDate() < day) d.setDate(0);
  return d;
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
  if (!token) throw new Error("Missing offline access token for shop. Reinstall/re-auth the app.");

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
    throw new Error(`Shopify GraphQL failed: ${resp.status} ${resp.statusText} ${t}`);
  }

  const json = await resp.json().catch(() => null);
  if (json?.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json?.data;
}

async function getEligibleProductGidsByTags(shop: string, includeTags: string[]): Promise<string[] | null> {
  const tags = includeTags.map((t) => t.trim()).filter(Boolean);
  if (tags.length === 0) return null;

  const q = tags.map((t) => `tag:${JSON.stringify(t)}`).join(" OR ");
  const query = `
    query ProductsByTag($q: String!) {
      products(first: 250, query: $q) { nodes { id } }
    }
  `;

  const data = await shopifyGraphql(shop, query, { q });
  const nodes: any[] = data?.products?.nodes ?? [];
  const ids = nodes.map((n) => String(n.id)).filter(Boolean);
  return ids.length ? ids : null;
}

function makeDiscountCode(prefix: string) {
  const suffix = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${suffix}`;
}

async function createShopifyDiscountCode(params: {
  shop: string;
  customerGid: string;
  amountOff: number;
  minSubtotal: number;
  eligibleProductIds: string[] | null;
  code: string;
  title: string;
}) {
  const { shop, customerGid, amountOff, minSubtotal, eligibleProductIds, code, title } = params;

  const mutation = `
    mutation CreateCode($basicCodeDiscount: DiscountCodeBasicInput!) {
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

  const startsAt = new Date().toISOString();
  const endsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const variables: any = {
    basicCodeDiscount: {
      title,
      code,
      startsAt,
      endsAt,
      appliesOncePerCustomer: true,
      usageLimit: 1,
      customerSelection: { customers: { add: [customerGid] } },
      customerGets: {
        value: {
          discountAmount: { amount: amountOff.toFixed(2), appliesOnEachItem: false },
        },
        items:
          eligibleProductIds && eligibleProductIds.length > 0
            ? { products: { add: eligibleProductIds } }
            : { all: true },
      },
      minimumRequirement:
        minSubtotal && minSubtotal > 0
          ? { subtotal: { greaterThanOrEqualToSubtotal: String(minSubtotal.toFixed(2)) } }
          : null,
    },
  };

  const data = await shopifyGraphql(shop, mutation, variables);
  const result = data?.discountCodeBasicCreate;
  const userErrors: any[] = result?.userErrors ?? [];
  if (userErrors.length) throw new Error(`Discount create userErrors: ${JSON.stringify(userErrors)}`);

  const nodeId = String(result?.codeDiscountNode?.id ?? "");
  const returnedCode = String(result?.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code ?? code);
  if (!nodeId) throw new Error("Discount create returned no codeDiscountNode.id");
  return { nodeId, code: returnedCode };
}

function computeLedgerWithRunningBalance(
  currentBalance: number,
  descRows: Array<{ id: string; type: any; delta: number; description: string | null; createdAt: Date }>,
) {
  let running = currentBalance;

  // rows are in DESC order; running balance shown is the balance AFTER that event
  return descRows.map((r) => {
    const row: LedgerRow = {
      id: r.id,
      type: String(r.type),
      delta: r.delta,
      description: r.description,
      createdAt: r.createdAt.toISOString(),
      runningBalance: running,
    };
    running = running - r.delta;
    return row;
  });
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

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";

  const shop = (url.searchParams.get("shop") ?? "").toLowerCase();
  const customerId = url.searchParams.get("logged_in_customer_id") ?? "";
  const ok = verifyAppProxyHmac(url, apiSecret);

  if (!ok || !shop || !customerId) {
    return data<ActionData>({ ok: false, error: "Unauthorized or missing proxy params." }, { status: 401 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "redeem") {
    return data<ActionData>({ ok: false, error: "Unknown action." }, { status: 400 });
  }

  const settings = await getShopSettings(shop);

  const pointsReqRaw = Number(form.get("points") ?? 0) || 0;
  const pointsReq = clampInt(pointsReqRaw, 1, 1_000_000);

  const redemptionValueMap = (settings.redemptionValueMap as any) ?? {};
  const amountOff = Number(redemptionValueMap[String(pointsReq)] ?? 0) || 0;

  if (amountOff <= 0) {
    return data<ActionData>({ ok: false, error: "This reward tier is not configured." }, { status: 400 });
  }

  const existingActive = await db.redemption.findFirst({
    where: { shop, customerId, status: { in: ["ISSUED", "APPLIED"] } as any },
    orderBy: { createdAt: "desc" },
  });

  if (existingActive) {
    return data<ActionData>({
      ok: true,
      code: existingActive.code,
      value: existingActive.value,
      points: (existingActive as any).points ?? (existingActive as any).pointsSpent ?? pointsReq,
      note: "You already have an active code. Use it at checkout (or wait for it to expire).",
    });
  }

  const bal = await db.customerPointsBalance.findUnique({ where: { shop_customerId: { shop, customerId } } });
  const currentBalance = bal?.balance ?? 0;

  if (currentBalance < pointsReq) {
    return data<ActionData>({ ok: false, error: "Not enough points for that reward." }, { status: 400 });
  }

  // Browser provides idempotency key (hidden field) so repeated clicks don't issue twice
  const idemKey = String(form.get("idemKey") ?? crypto.randomUUID());
  const existingIdem = await db.redemption.findFirst({ where: { shop, customerId, idemKey } });
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

  const customerGid = await getCustomerGid(shop, customerId);

  const eligibleProducts = await getEligibleProductGidsByTags(shop, toStringListJson(settings.includeProductTags));
  const minSubtotal = Number(settings.redemptionMinOrder ?? 0) || 0;

  // Create discount code in Shopify + issue redemption atomically with ledger/balance updates
  const created = await createShopifyDiscountCode({
    shop,
    customerGid,
    amountOff,
    minSubtotal,
    eligibleProductIds: eligibleProducts,
    code,
    title,
  });

  const now = new Date();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.$transaction(async (tx) => {
    // write redemption
    await tx.redemption.create({
      data: {
        shop,
        customerId,
        points: pointsReq,
        value: Math.round(amountOff),
        code: created.code,
        discountNodeId: created.nodeId,
        status: "ISSUED",
        issuedAt: now,
        expiresAt,
        idemKey,
      } as any,
    });

    // write ledger
    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: "REDEEM",
        delta: -pointsReq,
        source: "REDEMPTION",
        sourceId: created.code,
        description: `Redeemed ${pointsReq} points for $${Math.round(amountOff)} off`,
        createdAt: now,
      },
    });

    // decrement points balance
    await tx.customerPointsBalance.upsert({
      where: { shop_customerId: { shop, customerId } },
      create: {
        shop,
        customerId,
        balance: Math.max(0, currentBalance - pointsReq),
        lifetimeEarned: 0,
        lifetimeRedeemed: pointsReq,
        lastActivityAt: now,
      },
      update: {
        balance: { decrement: pointsReq },
        lifetimeRedeemed: { increment: pointsReq },
        lastActivityAt: now,
      },
    });

    // floor at 0
    const b = await tx.customerPointsBalance.findUnique({ where: { shop_customerId: { shop, customerId } } });
    if (b && b.balance < 0) {
      await tx.customerPointsBalance.update({ where: { shop_customerId: { shop, customerId } }, data: { balance: 0 } });
    }
  });

  return data<ActionData>({ ok: true, code: created.code, value: amountOff, points: pointsReq });
};

function formatDateTime(s: string) {
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

export default function LoyaltyDashboard() {
  const d = useLoaderData<LoaderData>();
  const a = useActionData<ActionData>();

  if (!d.ok) {
    return (
      <main style={{ fontFamily: "system-ui", padding: 18 }}>
        <h2 style={{ marginTop: 0 }}>Lions Creek Rewards</h2>
        <p>Unauthorized or missing parameters.</p>
      </main>
    );
  }

  const active = d.activeRedemption;
  const stepsSorted = [...(d.redemptionSteps ?? [])].sort((x, y) => x - y);

  // Browser-safe idempotency key (avoid relying on node crypto on client)
  const idemKey = (globalThis as any)?.crypto?.randomUUID ? (globalThis as any).crypto.randomUUID() : String(Date.now());

  return (
    <main style={{ fontFamily: "system-ui", padding: 18, maxWidth: 980, margin: "0 auto" }}>
      <h2 style={{ marginTop: 0 }}>Lions Creek Rewards</h2>

      {a && !a.ok && (
        <section style={{ border: "1px solid #f2caca", background: "#fff5f5", borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <strong>Couldn’t complete that request.</strong>
          <div style={{ marginTop: 6 }}>{a.error}</div>
        </section>
      )}

      {a && a.ok && a.note && (
        <section style={{ border: "1px solid #cce3ff", background: "#f5faff", borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <strong>Note:</strong>
          <div style={{ marginTop: 6 }}>{a.note}</div>
        </section>
      )}

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>Points balance</div>
            <div style={{ fontSize: 34, fontWeight: 800 }}>{d.balance}</div>
            <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>
              Lifetime earned: <strong>{d.lifetimeEarned}</strong> • Lifetime redeemed: <strong>{d.lifetimeRedeemed}</strong>
            </div>
          </div>

          <div style={{ minWidth: 320 }}>
            <div style={{ fontSize: 13, opacity: 0.7 }}>Expiry policy</div>
            <div style={{ fontSize: 14, lineHeight: 1.4 }}>
              Points expire after <strong>{d.expiryMonths} months</strong> of inactivity (earning or redeeming resets the timer).
              <div style={{ marginTop: 6, opacity: 0.85 }}>
                {d.lastActivityAt ? (
                  <>
                    Last activity: <strong>{formatDateTime(d.lastActivityAt)}</strong>
                    {d.estimatedExpiryAt ? (
                      <>
                        <br />
                        Estimated expiry: <strong>{formatDateTime(d.estimatedExpiryAt)}</strong>
                      </>
                    ) : null}
                  </>
                ) : (
                  <>No activity recorded yet.</>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

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

        {active ? (
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
                    style={{
                      padding: "10px 14px",
                      borderRadius: 10,
                      border: "1px solid #ccc",
                      cursor: disabled ? "not-allowed" : "pointer",
                      background: disabled ? "#fafafa" : "white",
                      opacity: disabled ? 0.6 : 1,
                    }}
                    disabled={disabled}
                    title={val <= 0 ? "This reward tier is not configured yet." : undefined}
                  >
                    Redeem {pts} → ${Math.round(val)} code
                  </button>
                </Form>
              );
            })}
          </div>
        )}
      </section>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h3 style={{ marginTop: 0 }}>Recent activity</h3>

        <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 10 }}>
          Ledger includes earned points, redemptions, reversals, and expiries.
        </div>

        {d.ledger.length === 0 ? (
          <p style={{ margin: 0, opacity: 0.8 }}>No activity yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Date</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Type</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Delta</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Balance</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Description</th>
              </tr>
            </thead>
            <tbody>
              {d.ledger.map((l) => (
                <tr key={l.id}>
                  <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>{formatDateTime(l.createdAt)}</td>
                  <td style={{ padding: "8px 0" }}>{l.type}</td>
                  <td style={{ padding: "8px 0", textAlign: "right" }}>{l.delta}</td>
                  <td style={{ padding: "8px 0", textAlign: "right", fontWeight: 600 }}>{l.runningBalance}</td>
                  <td style={{ padding: "8px 0", opacity: 0.85 }}>{l.description ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
        <h3 style={{ marginTop: 0 }}>Your recent redemptions</h3>

        {d.redemptions.length === 0 ? (
          <p style={{ margin: 0, opacity: 0.8 }}>No redemptions yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Date</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Code</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Value</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Points</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Status</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Expires</th>
              </tr>
            </thead>
            <tbody>
              {d.redemptions.map((r) => (
                <tr key={r.id}>
                  <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>{formatDateTime(r.createdAt)}</td>
                  <td style={{ padding: "8px 0", fontWeight: 700 }}>{r.code}</td>
                  <td style={{ padding: "8px 0", textAlign: "right" }}>${Math.round(r.value)}</td>
                  <td style={{ padding: "8px 0", textAlign: "right" }}>{r.points}</td>
                  <td style={{ padding: "8px 0" }}>{r.status}</td>
                  <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>{r.expiresAt ? formatDateTime(r.expiresAt) : ""}</td>
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
