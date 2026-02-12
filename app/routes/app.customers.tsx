import { data, Form, useActionData, useLoaderData, Link } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

const ADMIN_API_VERSION = "2026-01";

type SettingsShape = {
  earnRate: number;
  redemptionMinOrder: number;
  excludedCustomerTags: string[];
  includeProductTags: string[];
  excludeProductTags: string[];
  redemptionSteps: number[];
  redemptionValueMap: Record<string, number>;
};

type CustomerHit = {
  id: string; // numeric Shopify customer id
  gid: string;
  displayName: string | null;
  email: string | null;
};

type LedgerRow = {
  id: string;
  type: string;
  delta: number;
  description: string | null;
  createdAt: string;
  runningBalance: number;
};

type ActionData =
  | {
      ok: true;
      message?: string;
      settings?: SettingsShape;

      // customer search
      hits?: CustomerHit[];
      selected?: CustomerHit;

      // customer state
      balance?: {
        balance: number;
        lifetimeEarned: number;
        lifetimeRedeemed: number;
        lastActivityAt: string | null;
      };
      ledger?: LedgerRow[];
      redemptions?: Array<{
        id: string;
        points: number;
        value: number;
        code: string;
        status: string;
        createdAt: string;
        expiresAt: string | null;
        appliedAt: string | null;
        consumedAt: string | null;
        consumedOrderId: string | null;
        expiredAt: string | null;
      }>;
    }
  | { ok: false; error: string };

function parseCsvList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function jsonList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.map(String);
  try {
    if (typeof value === "string") {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    }
  } catch {
    // ignore
  }
  return fallback;
}

function jsonNumberList(value: unknown, fallback: number[]): number[] {
  if (Array.isArray(value)) {
    const nums = value.map((x) => Number(x)).filter((n) => Number.isFinite(n));
    return nums.length ? nums : fallback;
  }
  try {
    if (typeof value === "string") {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        const nums = parsed.map((x) => Number(x)).filter((n) => Number.isFinite(n));
        return nums.length ? nums : fallback;
      }
    }
  } catch {
    // ignore
  }
  return fallback;
}

function jsonMap(value: unknown, fallback: Record<string, number>): Record<string, number> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(value as any)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[String(k)] = n;
    }
    return Object.keys(out).length ? out : fallback;
  }
  try {
    if (typeof value === "string") {
      const parsed = JSON.parse(value);
      return jsonMap(parsed, fallback);
    }
  } catch {
    // ignore
  }
  return fallback;
}

async function getShopSettings(shop: string): Promise<SettingsShape> {
  const defaults: SettingsShape = {
    earnRate: 1,
    redemptionMinOrder: 0,
    excludedCustomerTags: ["Wholesale"],
    includeProductTags: [],
    excludeProductTags: [],
    redemptionSteps: [500, 1000],
    redemptionValueMap: { "500": 10, "1000": 20 },
  };

  const settings = await db.shopSettings.findUnique({ where: { shop } }).catch(() => null);
  if (!settings) return defaults;

  return {
    earnRate: settings.earnRate ?? defaults.earnRate,
    redemptionMinOrder: settings.redemptionMinOrder ?? defaults.redemptionMinOrder,
    excludedCustomerTags: jsonList(settings.excludedCustomerTags, defaults.excludedCustomerTags),
    includeProductTags: jsonList(settings.includeProductTags, defaults.includeProductTags),
    excludeProductTags: jsonList(settings.excludeProductTags, defaults.excludeProductTags),
    redemptionSteps: jsonNumberList((settings as any).redemptionSteps, defaults.redemptionSteps),
    redemptionValueMap: jsonMap((settings as any).redemptionValueMap, defaults.redemptionValueMap),
  };
}

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const offlineId = `offline_${shop}`;
  const session = await db.session.findUnique({ where: { id: offlineId } }).catch(() => null);
  return session?.accessToken ?? null;
}

async function shopifyGraphql<T>(shop: string, accessToken: string, query: string, variables: any): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (!res.ok || json.errors) {
    const msg = json?.errors?.[0]?.message ?? `Shopify GraphQL failed (${res.status})`;
    throw new Error(msg);
  }
  return json.data as T;
}

async function searchCustomers(shop: string, q: string): Promise<CustomerHit[]> {
  const token = await getOfflineAccessToken(shop);
  if (!token) throw new Error("Missing offline token for this shop.");

  const query = `
    query Customers($first: Int!, $query: String!) {
      customers(first: $first, query: $query) {
        edges {
          node {
            id
            displayName
            email
          }
        }
      }
    }
  `;

  // Shopify customer search syntax: email:<email> is best for email.
  const shopifyQuery = q.includes("@") ? `email:${q}` : q;

  const data = await shopifyGraphql<{
    customers: { edges: Array<{ node: { id: string; displayName: string | null; email: string | null } }> };
  }>(shop, token, query, { first: 10, query: shopifyQuery });

  return (data.customers.edges ?? []).map((e) => {
    const gid = e.node.id;
    const id = String(gid.split("/").pop() ?? "").trim();
    return { id, gid, displayName: e.node.displayName ?? null, email: e.node.email ?? null };
  });
}

async function loadCustomerState(shop: string, customerId: string) {
  const balanceRow = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });

  const balance = {
    balance: balanceRow?.balance ?? 0,
    lifetimeEarned: balanceRow?.lifetimeEarned ?? 0,
    lifetimeRedeemed: balanceRow?.lifetimeRedeemed ?? 0,
    lastActivityAt: balanceRow?.lastActivityAt ? balanceRow.lastActivityAt.toISOString() : null,
  };

  const ledgerRaw = await db.pointsLedger.findMany({
    where: { shop, customerId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  // compute running balance backwards from current balance
  let running = balance.balance;
  const ledger: LedgerRow[] = ledgerRaw.map((r) => {
    const row: LedgerRow = {
      id: r.id,
      type: String(r.type),
      delta: r.delta,
      description: r.description ?? null,
      createdAt: r.createdAt.toISOString(),
      runningBalance: running,
    };
    running = running - r.delta;
    return row;
  });

  const redemptionsRaw = await db.redemption.findMany({
    where: { shop, customerId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const redemptions = redemptionsRaw.map((r: any) => ({
    id: r.id,
    points: Number(r.points ?? r.pointsSpent ?? 0),
    value: Number(r.value ?? 0),
    code: String(r.code ?? ""),
    status: String(r.status ?? ""),
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
    expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
    appliedAt: r.appliedAt ? new Date(r.appliedAt).toISOString() : null,
    consumedAt: r.consumedAt ? new Date(r.consumedAt).toISOString() : null,
    consumedOrderId: r.consumedOrderId ? String(r.consumedOrderId) : null,
    expiredAt: r.expiredAt ? new Date(r.expiredAt).toISOString() : null,
  }));

  return { balance, ledger, redemptions };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await getShopSettings(shop);

  return data({ shop, settings });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await getShopSettings(shop);

  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");

  if (intent === "saveSettings") {
    const earnRate = Math.max(0, Math.trunc(Number(form.get("earnRate") ?? 1) || 1));
    const redemptionMinOrder = Math.max(0, Math.trunc(Number(form.get("redemptionMinOrder") ?? 0) || 0));

    const excludedCustomerTags = parseCsvList(String(form.get("excludedCustomerTags") ?? ""));
    const includeProductTags = parseCsvList(String(form.get("includeProductTags") ?? ""));
    const excludeProductTags = parseCsvList(String(form.get("excludeProductTags") ?? ""));

    const redemptionSteps = parseCsvList(String(form.get("redemptionSteps") ?? ""))
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0);

    // redemptionValueMap as JSON (recommended)
    let redemptionValueMap: Record<string, number> = settings.redemptionValueMap;
    const rawMap = String(form.get("redemptionValueMap") ?? "").trim();
    if (rawMap) {
      try {
        redemptionValueMap = jsonMap(JSON.parse(rawMap), settings.redemptionValueMap);
      } catch {
        // keep prior
      }
    }

    await db.shopSettings.upsert({
      where: { shop },
      create: {
        shop,
        earnRate,
        redemptionMinOrder,
        excludedCustomerTags,
        includeProductTags,
        excludeProductTags,
        redemptionSteps: redemptionSteps.length ? redemptionSteps : settings.redemptionSteps,
        redemptionValueMap,
        updatedAt: new Date(),
      } as any,
      update: {
        earnRate,
        redemptionMinOrder,
        excludedCustomerTags,
        includeProductTags,
        excludeProductTags,
        redemptionSteps: redemptionSteps.length ? redemptionSteps : settings.redemptionSteps,
        redemptionValueMap,
        updatedAt: new Date(),
      } as any,
    });

    return data<ActionData>({ ok: true, message: "Settings saved.", settings: await getShopSettings(shop) });
  }

  if (intent === "searchCustomer") {
    const q = String(form.get("q") ?? "").trim();
    if (!q) return data<ActionData>({ ok: false, error: "Enter a customer ID, email, or name." }, { status: 400 });

    // If numeric, treat as Shopify customer id directly.
    if (/^\d+$/.test(q)) {
      const selected: CustomerHit = { id: q, gid: `gid://shopify/Customer/${q}`, displayName: null, email: null };
      const state = await loadCustomerState(shop, q);
      return data<ActionData>({ ok: true, settings, selected, ...state });
    }

    const hits = await searchCustomers(shop, q);
    if (!hits.length) return data<ActionData>({ ok: false, error: "No customers found in Shopify for that query." }, { status: 404 });

    if (hits.length === 1) {
      const selected = hits[0];
      const state = await loadCustomerState(shop, selected.id);
      return data<ActionData>({ ok: true, settings, hits, selected, ...state });
    }

    return data<ActionData>({ ok: true, settings, hits, message: "Multiple matches found — select one." });
  }

  if (intent === "selectCustomer") {
    const customerId = String(form.get("customerId") ?? "").trim();
    if (!customerId) return data<ActionData>({ ok: false, error: "Missing customerId." }, { status: 400 });

    const selected: CustomerHit = { id: customerId, gid: `gid://shopify/Customer/${customerId}`, displayName: null, email: null };
    const state = await loadCustomerState(shop, customerId);
    return data<ActionData>({ ok: true, settings, selected, ...state });
  }

  if (intent === "adjustPoints") {
    const customerId = String(form.get("customerId") ?? "").trim();
    const delta = Math.trunc(Number(form.get("delta") ?? 0) || 0);
    const reason = String(form.get("reason") ?? "").trim();

    if (!customerId || !delta || !reason) {
      return data<ActionData>({ ok: false, error: "CustomerId, delta, and reason are required." }, { status: 400 });
    }

    await db.$transaction(async (tx) => {
      await tx.pointsLedger.create({
        data: {
          shop,
          customerId,
          type: "ADJUST",
          delta,
          source: "ADMIN",
          sourceId: String(session.id),
          description: `Admin adjust: ${reason}`,
          createdAt: new Date(),
        },
      });

      const bal = await tx.customerPointsBalance.upsert({
        where: { shop_customerId: { shop, customerId } },
        create: {
          shop,
          customerId,
          balance: delta,
          lifetimeEarned: Math.max(0, delta),
          lifetimeRedeemed: 0,
          lastActivityAt: new Date(),
        },
        update: {
          balance: { increment: delta },
          lastActivityAt: new Date(),
        },
      });

      if (bal.balance < 0) {
        await tx.customerPointsBalance.update({
          where: { shop_customerId: { shop, customerId } },
          data: { balance: 0 },
        });
      }
    });

    const selected: CustomerHit = { id: customerId, gid: `gid://shopify/Customer/${customerId}`, displayName: null, email: null };
    const state = await loadCustomerState(shop, customerId);
    return data<ActionData>({ ok: true, message: "Adjustment applied.", settings, selected, ...state });
  }

  return data<ActionData>({ ok: false, error: "Unknown action." }, { status: 400 });
};

export default function CustomersAdmin() {
  const { shop, settings } = useLoaderData<typeof loader>();
  const a = useActionData<ActionData>();

  const currentSettings = a?.ok && a.settings ? a.settings : settings;

  return (
    <div style={{ padding: 18, maxWidth: 980 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>Customer Ops</h1>
        <Link to="/app" style={{ opacity: 0.8 }}>
          ← Back
        </Link>
      </div>
      <div style={{ opacity: 0.7, marginTop: 6, marginBottom: 14 }}>Shop: {shop}</div>

      {/* Settings */}
      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Program Settings</h2>

        <Form method="post">
          <input type="hidden" name="_intent" value="saveSettings" />

          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
            <label>
              Earn rate (points per $1 eligible net)
              <input name="earnRate" defaultValue={currentSettings.earnRate} type="number" step="1" min="0" />
            </label>

            <label>
              Minimum order subtotal to redeem (CAD)
              <input name="redemptionMinOrder" defaultValue={currentSettings.redemptionMinOrder} type="number" step="1" min="0" />
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              Excluded customer tags (CSV)
              <input name="excludedCustomerTags" defaultValue={(currentSettings.excludedCustomerTags ?? []).join(", ")} />
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              Include product tags (CSV) — blank means “all eligible”
              <input name="includeProductTags" defaultValue={(currentSettings.includeProductTags ?? []).join(", ")} />
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              Exclude product tags (CSV)
              <input name="excludeProductTags" defaultValue={(currentSettings.excludeProductTags ?? []).join(", ")} />
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              Redemption steps (CSV) — v1 default: 500, 1000
              <input name="redemptionSteps" defaultValue={(currentSettings.redemptionSteps ?? []).join(", ")} />
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              Redemption value map (JSON) — v1 default: {"{"}"500":10,"1000":20{"}"}
              <textarea name="redemptionValueMap" defaultValue={JSON.stringify(currentSettings.redemptionValueMap ?? {}, null, 0)} rows={2} />
            </label>
          </div>

          <button style={{ marginTop: 12 }} type="submit">
            Save settings
          </button>
        </Form>

        <div style={{ marginTop: 10, opacity: 0.8 }}>
          Redemptions remain single-active per customer by default; expiry job will expire unused codes.
        </div>

        {a && "ok" in a && a.ok && a.message ? <div style={{ marginTop: 10 }}>✅ {a.message}</div> : null}
        {a && "ok" in a && !a.ok ? <div style={{ marginTop: 10, color: "crimson" }}>⚠️ {a.error}</div> : null}
      </section>

      {/* Customer search */}
      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Customer lookup</h2>

        <Form method="post" style={{ display: "flex", gap: 10, alignItems: "end" }}>
          <input type="hidden" name="_intent" value="searchCustomer" />
          <label style={{ flex: 1 }}>
            Search by customer ID, email, or name
            <input name="q" placeholder="e.g. 1234567890 or jane@email.com" />
          </label>
          <button type="submit">Search</button>
        </Form>

        {a && a.ok && a.hits && a.hits.length > 1 && !a.selected ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ marginBottom: 8, opacity: 0.8 }}>Multiple Shopify matches:</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {a.hits.map((h) => (
                <li key={h.gid} style={{ marginBottom: 6 }}>
                  <Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="_intent" value="selectCustomer" />
                    <input type="hidden" name="customerId" value={h.id} />
                    <button type="submit">Select</button>
                  </Form>{" "}
                  <span style={{ marginLeft: 8 }}>
                    <strong>{h.displayName ?? "(no name)"}</strong> — {h.email ?? "(no email)"} — ID {h.id}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {a && a.ok && a.selected && a.balance ? (
          <div style={{ marginTop: 14 }}>
            <h3 style={{ margin: "10px 0" }}>Customer {a.selected.id}</h3>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Balance</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{a.balance.balance}</div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                  Lifetime earned: {a.balance.lifetimeEarned} • Lifetime redeemed: {a.balance.lifetimeRedeemed}
                </div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  Last activity: {a.balance.lastActivityAt ? new Date(a.balance.lastActivityAt).toLocaleString() : "(none)"}
                </div>
              </div>

              <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Manual adjustment</div>
                <Form method="post" style={{ display: "grid", gap: 8, marginTop: 6 }}>
                  <input type="hidden" name="_intent" value="adjustPoints" />
                  <input type="hidden" name="customerId" value={a.selected.id} />
                  <label>
                    Delta (positive or negative)
                    <input name="delta" type="number" step="1" />
                  </label>
                  <label>
                    Reason
                    <input name="reason" placeholder="e.g. Customer service goodwill" />
                  </label>
                  <button type="submit">Apply adjustment</button>
                </Form>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
              <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Recent ledger (latest 100)</div>
                <div style={{ maxHeight: 320, overflow: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>When</th>
                        <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>Type</th>
                        <th style={{ textAlign: "right", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>Δ</th>
                        <th style={{ textAlign: "right", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>Running</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(a.ledger ?? []).map((r) => (
                        <tr key={r.id} style={{ borderTop: "1px solid #f2f2f2" }}>
                          <td style={{ padding: "6px 0", fontSize: 12 }}>{new Date(r.createdAt).toLocaleString()}</td>
                          <td style={{ padding: "6px 0", fontSize: 12 }}>{r.type}</td>
                          <td style={{ padding: "6px 0", fontSize: 12, textAlign: "right" }}>{r.delta}</td>
                          <td style={{ padding: "6px 0", fontSize: 12, textAlign: "right" }}>{r.runningBalance}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Redemptions (latest 20)</div>
                <div style={{ maxHeight: 320, overflow: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>When</th>
                        <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>Code</th>
                        <th style={{ textAlign: "right", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>Pts</th>
                        <th style={{ textAlign: "right", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>$</th>
                        <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(a.redemptions ?? []).map((r) => (
                        <tr key={r.id} style={{ borderTop: "1px solid #f2f2f2" }}>
                          <td style={{ padding: "6px 0", fontSize: 12 }}>{new Date(r.createdAt).toLocaleString()}</td>
                          <td style={{ padding: "6px 0", fontSize: 12 }}>
                            <code>{r.code}</code>
                          </td>
                          <td style={{ padding: "6px 0", fontSize: 12, textAlign: "right" }}>{r.points}</td>
                          <td style={{ padding: "6px 0", fontSize: 12, textAlign: "right" }}>{r.value}</td>
                          <td style={{ padding: "6px 0", fontSize: 12 }}>{r.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                  Tip: If a customer claims a code “doesn’t work”, check it’s not EXPIRED/VOID and confirm min order subtotal + eligible products rules.
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
