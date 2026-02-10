import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, useLoaderData } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";

type LoaderData = {
  ok: boolean;
  shop: string;
  customerId: string;
  balance: number;
  lastActivityAt: string | null;
  ledger: Array<{
    id: string;
    type: string;
    delta: number;
    description: string | null;
    createdAt: string;
  }>;
  issuedCodes: Array<{
    id: string;
    points: number;
    value: number;
    code: string;
    status: string;
    createdAt: string;
  }>;
  redemptionMinOrder: number;
};

function timingSafeEqual(a: Buffer, b: Buffer) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Shopify App Proxy HMAC:
 * - Build message from query params sorted by key, excluding `hmac` and `signature`
 * - Join as: key=value&key=value
 * - HMAC-SHA256 with API secret, compare hex digest
 */
function verifyAppProxyHmac(url: URL, apiSecret: string): boolean {
  const hmac = url.searchParams.get("hmac");
  if (!hmac || !apiSecret) return false;

  const pairs: string[] = [];
  const keys = Array.from(url.searchParams.keys())
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort();

  for (const k of keys) {
    // App Proxy can repeat keys; include each occurrence in order
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

/**
 * Offline token row comes from PrismaSessionStorage with id: offline_{shop}
 */
async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const s = await db.session.findUnique({ where: { id } }).catch(() => null);
  return s?.accessToken ?? null;
}

async function shopifyGraphql(shop: string, query: string, variables: any) {
  const token = await getOfflineAccessToken(shop);
  if (!token) throw new Error("Missing offline access token for shop. Reinstall/re-auth the app.");

  // Your app is configured for ApiVersion.October25 in shopify.server.ts -> 2025-10
  const endpoint = `https://${shop}/admin/api/2025-10/graphql.json`;

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
  if (json?.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json?.data;
}

/**
 * If includeProductTags is configured, restrict discount to products matching those tags.
 * We keep it simple: query products by tag OR tag OR tag (up to first 250).
 * If no include tags are configured, we return null -> discount applies to all items.
 */
async function getEligibleProductGidsByTags(shop: string, includeTags: string[]): Promise<string[] | null> {
  const tags = includeTags.map((t) => t.trim()).filter(Boolean);
  if (tags.length === 0) return null;

  // Shopify product search syntax: tag:foo OR tag:bar
  const q = tags.map((t) => `tag:${JSON.stringify(t)}`).join(" OR ");
  const query = `
    query ProductsByTag($q: String!) {
      products(first: 250, query: $q) {
        nodes { id }
      }
    }
  `;

  const data = await shopifyGraphql(shop, query, { q });
  const nodes: any[] = data?.products?.nodes ?? [];
  const ids = nodes.map((n) => String(n.id)).filter(Boolean);

  if (ids.length === 0) return null; // fallback to all items if none found
  return ids;
}

function makeDiscountCode(prefix: string) {
  const suffix = crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 chars
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
            ... on DiscountCodeBasic {
              title
              codes(first: 5) { nodes { code } }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const startsAt = new Date().toISOString();
  // Keep short-lived codes to reduce clutter; can be tuned.
  const endsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const variables: any = {
    basicCodeDiscount: {
      title,
      code,
      startsAt,
      endsAt,
      appliesOncePerCustomer: true,
      usageLimit: 1,
      customerSelection: {
        customers: { add: [customerGid] },
      },
      customerGets: {
        value: {
          discountAmount: {
            amount: amountOff.toFixed(2),
            appliesOnEachItem: false,
          },
        },
        items:
          eligibleProductIds && eligibleProductIds.length > 0
            ? { products: { add: eligibleProductIds } }
            : { all: true },
      },
      minimumRequirement:
        minSubtotal && minSubtotal > 0
          ? {
              subtotal: {
                greaterThanOrEqualToSubtotal: String(minSubtotal.toFixed(2)),
              },
            }
          : null,
    },
  };

  const data = await shopifyGraphql(shop, mutation, variables);
  const result = data?.discountCodeBasicCreate;

  const userErrors: any[] = result?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(`Discount create userErrors: ${JSON.stringify(userErrors)}`);
  }

  const nodeId = String(result?.codeDiscountNode?.id ?? "");
  const returnedCode = String(result?.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code ?? code);

  if (!nodeId) throw new Error("Discount create returned no codeDiscountNode.id");
  return { nodeId, code: returnedCode };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";

  // App Proxy required params
  const shop = (url.searchParams.get("shop") ?? "").toLowerCase();
  const customerId = url.searchParams.get("logged_in_customer_id") ?? "";
  const ok = verifyAppProxyHmac(url, apiSecret);

  if (!ok) {
    return data(
      { ok: false, shop, customerId, balance: 0, lastActivityAt: null, ledger: [], issuedCodes: [], redemptionMinOrder: 0 },
      { status: 401 },
    );
  }
  if (!shop || !customerId) {
    return data(
      { ok: false, shop, customerId, balance: 0, lastActivityAt: null, ledger: [], issuedCodes: [], redemptionMinOrder: 0 },
      { status: 400 },
    );
  }

  const settings = await getShopSettings(shop);

  const bal = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });

  const ledger = await db.pointsLedger.findMany({
    where: { shop, customerId },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { id: true, type: true, delta: true, description: true, createdAt: true },
  });

  const issuedCodes = await db.redemption.findMany({
    where: { shop, customerId, status: { in: ["ISSUED"] } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, points: true, value: true, code: true, status: true, createdAt: true },
  });

  const payload: LoaderData = {
    ok: true,
    shop,
    customerId,
    balance: bal?.balance ?? 0,
    lastActivityAt: bal?.lastActivityAt ? bal.lastActivityAt.toISOString() : null,
    ledger: ledger.map((l) => ({
      id: l.id,
      type: l.type,
      delta: l.delta,
      description: l.description,
      createdAt: l.createdAt.toISOString(),
    })),
    issuedCodes: issuedCodes.map((r) => ({
      id: r.id,
      points: r.points,
      value: r.value,
      code: r.code,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
    redemptionMinOrder: Number(settings.redemptionMinOrder ?? 0) || 0,
  };

  return data(payload);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";

  const shop = (url.searchParams.get("shop") ?? "").toLowerCase();
  const customerId = url.searchParams.get("logged_in_customer_id") ?? "";

  if (!verifyAppProxyHmac(url, apiSecret)) {
    return data({ ok: false, error: "Unauthorized (bad HMAC)" }, { status: 401 });
  }
  if (!shop || !customerId) {
    return data({ ok: false, error: "Missing shop or customer" }, { status: 400 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "redeem") {
    return data({ ok: false, error: "Unknown intent" }, { status: 400 });
  }

  const pointsReq = clampInt(Number(form.get("points") ?? 0) || 0, 0, 1000);
  if (![500, 1000].includes(pointsReq)) {
    return data({ ok: false, error: "Invalid points amount. Choose 500 or 1000." }, { status: 400 });
  }

  const settings = await getShopSettings(shop);
  const valueMap = settings.redemptionValueMap ?? { "500": 10, "1000": 20 };
  const amountOff = Number(valueMap[String(pointsReq)] ?? 0) || 0;

  if (amountOff <= 0) {
    return data({ ok: false, error: "Redemption value map not configured for this points amount." }, { status: 400 });
  }

  const balanceRow = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });

  const balance = balanceRow?.balance ?? 0;
  if (balance < pointsReq) {
    return data({ ok: false, error: `Insufficient points. You have ${balance}.` }, { status: 400 });
  }

  // Idempotency: client can pass an idempotency key; if omitted, we generate one per request
  const idemKey = String(form.get("idemKey") ?? crypto.randomUUID());

  // If already issued for this key, return it (safe retry)
  const existing = await db.redemption.findFirst({
    where: { shop, customerId, idemKey },
  });
  if (existing) {
    return data({ ok: true, code: existing.code, value: existing.value, points: existing.points });
  }

  // Customer GID required by discountCodeBasicCreate customerSelection
  const customerGid = `gid://shopify/Customer/${customerId}`;

  // If includeProductTags configured, restrict discount to those products
  const includeTags: string[] = (settings.includeProductTags ?? []).map((t: any) => String(t).trim()).filter(Boolean);
  const eligibleProductIds = await getEligibleProductGidsByTags(shop, includeTags);

  const minSubtotal = Number(settings.redemptionMinOrder ?? 0) || 0;

  const code = makeDiscountCode(pointsReq === 500 ? "LC-REW10" : "LC-REW20");
  const title = pointsReq === 500 ? "Lions Creek Rewards - $10" : "Lions Creek Rewards - $20";

  // Create Shopify code discount
  const created = await createShopifyDiscountCode({
    shop,
    customerGid,
    amountOff,
    minSubtotal,
    eligibleProductIds,
    code,
    title,
  });

  // Persist redemption + ledger + balance update
  await db.$transaction(async (tx) => {
    await tx.redemption.create({
      data: {
        shop,
        customerId,
        points: pointsReq,
        value: amountOff,
        code: created.code,
        discountNodeId: created.nodeId,
        status: "ISSUED",
        idemKey,
        createdAt: new Date(),
      },
    });

    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: "REDEEM",
        delta: -pointsReq,
        source: "REDEMPTION",
        sourceId: created.nodeId,
        description: `Redeemed ${pointsReq} points for $${amountOff.toFixed(0)} off`,
        createdAt: new Date(),
      },
    });

    await tx.customerPointsBalance.update({
      where: { shop_customerId: { shop, customerId } },
      data: {
        balance: { decrement: pointsReq },
        lifetimeRedeemed: { increment: pointsReq },
        lastActivityAt: new Date(),
      },
    });

    // Safety clamp (should not happen, but protects against concurrent updates)
    const b = await tx.customerPointsBalance.findUnique({
      where: { shop_customerId: { shop, customerId } },
    });
    if (b && b.balance < 0) {
      await tx.customerPointsBalance.update({
        where: { shop_customerId: { shop, customerId } },
        data: { balance: 0 },
      });
    }
  });

  return data({ ok: true, code: created.code, value: amountOff, points: pointsReq });
};

export default function LoyaltyDashboard() {
  const d = useLoaderData<LoaderData>();

  if (!d.ok) {
    return (
      <main style={{ fontFamily: "system-ui", padding: 18 }}>
        <h2>Lions Creek Rewards</h2>
        <p>Unauthorized or missing parameters.</p>
      </main>
    );
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: 18, maxWidth: 980, margin: "0 auto" }}>
      <h2 style={{ marginTop: 0 }}>Lions Creek Rewards</h2>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "baseline" }}>
          <div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>Points balance</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{d.balance}</div>
          </div>
          <div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>Rewards</div>
            <div style={{ fontSize: 16 }}>
              500 pts = $10 • 1000 pts = $20
              {d.redemptionMinOrder > 0 ? (
                <span style={{ opacity: 0.75 }}> • Min order ${d.redemptionMinOrder.toFixed(2)}</span>
              ) : null}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Form method="post">
            <input type="hidden" name="intent" value="redeem" />
            <input type="hidden" name="points" value="500" />
            <input type="hidden" name="idemKey" value={crypto.randomUUID()} />
            <button
              type="submit"
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #ccc",
                cursor: "pointer",
                background: "white",
              }}
              disabled={d.balance < 500}
              title={d.balance < 500 ? "Not enough points" : "Generate a $10 code"}
            >
              Redeem 500 → $10 code
            </button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="redeem" />
            <input type="hidden" name="points" value="1000" />
            <input type="hidden" name="idemKey" value={crypto.randomUUID()} />
            <button
              type="submit"
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #ccc",
                cursor: "pointer",
                background: "white",
              }}
              disabled={d.balance < 1000}
              title={d.balance < 1000 ? "Not enough points" : "Generate a $20 code"}
            >
              Redeem 1000 → $20 code
            </button>
          </Form>
        </div>

        <p style={{ marginTop: 10, fontSize: 13, opacity: 0.75 }}>
          After you redeem, you’ll receive a one-time discount code. Enter the code at checkout. Codes expire in 7 days.
        </p>
      </section>

      {d.issuedCodes.length > 0 && (
        <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <h3 style={{ marginTop: 0 }}>Your active codes</h3>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            {d.issuedCodes.map((r) => (
              <li key={r.id}>
                <strong>{r.code}</strong> — ${r.value.toFixed(0)} off ({r.points} pts) • issued{" "}
                {new Date(r.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
        <h3 style={{ marginTop: 0 }}>Recent activity</h3>
        {d.ledger.length === 0 ? (
          <p style={{ margin: 0, opacity: 0.8 }}>No activity yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Date</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Type</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Points</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", paddingBottom: 8 }}>Description</th>
              </tr>
            </thead>
            <tbody>
              {d.ledger.map((l) => (
                <tr key={l.id}>
                  <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>{new Date(l.createdAt).toLocaleString()}</td>
                  <td style={{ padding: "8px 0" }}>{l.type}</td>
                  <td style={{ padding: "8px 0", textAlign: "right" }}>{l.delta}</td>
                  <td style={{ padding: "8px 0", opacity: 0.85 }}>{l.description ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
