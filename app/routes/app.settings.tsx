import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, Link, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

/**
 * Lions Creek Rewards — Admin Settings
 *
 * IMPORTANT (React Router / Vite):
 * - Do NOT import *.server modules that are used by the default component.
 * - Only server exports (loader/action) may depend on server-only modules.
 *
 * This file:
 * - Stores ShopSettings in Prisma
 * - Computes eligibility diagnostics via Shopify Admin GraphQL using offline token
 * - Validates:
 *    - product include/exclude tags that match 0 products
 *    - include/exclude overlap (same tag in both lists)
 *    - sample of eligible products from effective query
 *    - excluded customer tags that match 0 customers (typo/unexpected casing)
 */

// v1.1 hard requirements
const V1_REDEMPTION_STEPS = [500, 1000] as const;
const V1_REDEMPTION_VALUE_MAP: Record<string, number> = { "500": 10, "1000": 20 };

type ActionData = { ok: true; message: string } | { ok: false; error: string };

type EligiblePreviewProduct = { id: string; title: string; handle: string | null };

type EligibilityDiagnostics = {
  computedAt: string;

  // Product eligibility
  effectiveProductQuery: string | null;
  includeMissingProductTags: string[];
  excludeMissingProductTags: string[];
  overlapProductTags: string[];
  eligibleProductSample: EligiblePreviewProduct[];
  eligibleProductSampleHasMore: boolean;

  // Customer exclusion
  excludedCustomerTags: string[];
  excludedCustomerMissingTags: string[];

  warnings: string[];
  notes: string[];
};

type ShopSettingsShape = {
  earnRate: number;
  redemptionMinOrder: number;
  excludedCustomerTags: string[];
  includeProductTags: string[];
  excludeProductTags: string[];
  redemptionSteps: number[];
  redemptionValueMap: Record<string, number>;
};

type LoaderData = {
  shop: string;
  settings: ShopSettingsShape;
  diagnostics: EligibilityDiagnostics;
};

function clampInt(n: any, min: number, max: number): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function csvToList(raw: FormDataEntryValue | null): string[] {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function toStringListJson(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean);
  return [];
}

function normalizeTagList(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags ?? []) {
    const v = String(t ?? "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function buildProductTagTerm(tag: string): string {
  // Shopify product search term
  return `tag:${JSON.stringify(tag)}`;
}

function buildCustomerTagTerm(tag: string): string {
  // Shopify customer search term
  return `tag:${JSON.stringify(tag)}`;
}

function buildEffectiveProductEligibilityQuery(includeTags: string[], excludeTags: string[]): string | null {
  const inc = normalizeTagList(includeTags);
  const exc = normalizeTagList(excludeTags);

  if (inc.length === 0 && exc.length === 0) return null;

  const includeQ = inc.length ? `(${inc.map(buildProductTagTerm).join(" OR ")})` : "";
  const excludeQ = exc.length ? exc.map((t) => `-${buildProductTagTerm(t)}`).join(" ") : "";
  return [includeQ, excludeQ].filter(Boolean).join(" ").trim();
}

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const s = await db.session.findUnique({ where: { id } }).catch(() => null);
  return s?.accessToken ?? null;
}

async function shopifyGraphql(shop: string, query: string, variables: any) {
  const token = await getOfflineAccessToken(shop);
  if (!token) throw new Error("Missing offline access token for shop. Reinstall/re-auth the app.");

  // Keep consistent with other routes in this app:
  const endpoint = `https://${shop}/admin/api/2026-01/graphql.json`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });

  const text = await resp.text().catch(() => "");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!resp.ok) {
    throw new Error(`Shopify GraphQL failed: ${resp.status} ${resp.statusText}${text ? ` ${text}` : ""}`);
  }
  if (json?.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json?.data ?? null;
}

async function getShopSettings(shop: string): Promise<ShopSettingsShape> {
  const defaults: ShopSettingsShape = {
    earnRate: 1,
    redemptionMinOrder: 0,
    // Default is helpful for your use case; remove in UI if you don't want it.
    excludedCustomerTags: ["Wholesale"],
    includeProductTags: [],
    excludeProductTags: [],
    redemptionSteps: [...V1_REDEMPTION_STEPS],
    redemptionValueMap: { ...V1_REDEMPTION_VALUE_MAP },
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
    redemptionValueMap: ((existing as any).redemptionValueMap as any) ?? defaults.redemptionValueMap,
  };
}

async function computeEligibilityDiagnostics(shop: string, settings: ShopSettingsShape): Promise<EligibilityDiagnostics> {
  const includeProductTags = normalizeTagList(settings.includeProductTags ?? []);
  const excludeProductTags = normalizeTagList(settings.excludeProductTags ?? []);
  const excludedCustomerTags = normalizeTagList(settings.excludedCustomerTags ?? []);

  const computedAt = new Date().toISOString();
  const overlapProductTags = includeProductTags.filter((t) =>
    excludeProductTags.some((x) => x.toLowerCase() === t.toLowerCase()),
  );

  const effectiveProductQuery = buildEffectiveProductEligibilityQuery(includeProductTags, excludeProductTags);

  const diagnostics: EligibilityDiagnostics = {
    computedAt,

    effectiveProductQuery,
    includeMissingProductTags: [],
    excludeMissingProductTags: [],
    overlapProductTags,
    eligibleProductSample: [],
    eligibleProductSampleHasMore: false,

    excludedCustomerTags,
    excludedCustomerMissingTags: [],

    warnings: [],
    notes: [],
  };

  // Notes
  if (!effectiveProductQuery) {
    diagnostics.notes.push("No product tag filters set: all products are eligible for earning/redemption.");
  } else if (includeProductTags.length > 0 && excludeProductTags.length === 0) {
    diagnostics.notes.push("Include tags set: only products with at least one include tag are eligible.");
  } else if (includeProductTags.length === 0 && excludeProductTags.length > 0) {
    diagnostics.notes.push("Exclude tags set: all products are eligible except those with an excluded tag.");
  } else {
    diagnostics.notes.push("Include + exclude tags set: must match include tags and must NOT match excluded tags.");
  }

  if (overlapProductTags.length > 0) {
    diagnostics.warnings.push(
      `Product tag overlap detected (same tag in include and exclude): ${overlapProductTags.join(", ")}. Exclude wins.`,
    );
  }

  if (excludedCustomerTags.length === 0) {
    diagnostics.notes.push("No excluded customer tags set: all customers can earn/redeem.");
  } else {
    diagnostics.notes.push(
      `Excluded customer tags active: customers with any of these tags cannot earn/redeem (${excludedCustomerTags.join(
        ", ",
      )}).`,
    );
  }

  // Nothing to validate remotely?
  const needsRemoteChecks = Boolean(effectiveProductQuery) || excludedCustomerTags.length > 0;
  if (!needsRemoteChecks) return diagnostics;

  // Cap to keep query bounded
  const includeCapped = includeProductTags.slice(0, 20);
  const excludeCapped = excludeProductTags.slice(0, 20);
  const excludedCustomerCapped = excludedCustomerTags.slice(0, 20);

  // Build one GraphQL request with many small queries
  const varDefs: string[] = [];
  const varVals: Record<string, string> = {};
  const fieldLines: string[] = [];

  if (effectiveProductQuery) {
    varDefs.push(`$qEligibleProducts: String!`);
    varVals.qEligibleProducts = effectiveProductQuery;
    fieldLines.push(`
      eligibleProducts: products(first: 5, query: $qEligibleProducts) {
        pageInfo { hasNextPage }
        nodes { id title handle }
      }
    `);
  }

  includeCapped.forEach((tag, i) => {
    const v = `qIncProd${i}`;
    varDefs.push(`$${v}: String!`);
    varVals[v] = buildProductTagTerm(tag);
    fieldLines.push(`incProd${i}: products(first: 1, query: $${v}) { nodes { id } }`);
  });

  excludeCapped.forEach((tag, i) => {
    const v = `qExcProd${i}`;
    varDefs.push(`$${v}: String!`);
    varVals[v] = buildProductTagTerm(tag);
    fieldLines.push(`excProd${i}: products(first: 1, query: $${v}) { nodes { id } }`);
  });

  excludedCustomerCapped.forEach((tag, i) => {
    const v = `qExcCust${i}`;
    varDefs.push(`$${v}: String!`);
    varVals[v] = buildCustomerTagTerm(tag);
    fieldLines.push(`excCust${i}: customers(first: 1, query: $${v}) { nodes { id } }`);
  });

  const query = `
    query EligibilityDiagnostics(${varDefs.join(", ")}) {
      ${fieldLines.join("\n")}
    }
  `;

  try {
    const res = await shopifyGraphql(shop, query, varVals);

    // Eligible sample
    if (effectiveProductQuery) {
      const eligibleNodes: any[] = res?.eligibleProducts?.nodes ?? [];
      diagnostics.eligibleProductSample = eligibleNodes.map((n) => ({
        id: String(n?.id ?? ""),
        title: String(n?.title ?? ""),
        handle: n?.handle ? String(n.handle) : null,
      }));
      diagnostics.eligibleProductSampleHasMore = Boolean(res?.eligibleProducts?.pageInfo?.hasNextPage);
    }

    // Missing tags (products)
    includeCapped.forEach((tag, i) => {
      const nodes: any[] = res?.[`incProd${i}`]?.nodes ?? [];
      if (!nodes.length) diagnostics.includeMissingProductTags.push(tag);
    });

    excludeCapped.forEach((tag, i) => {
      const nodes: any[] = res?.[`excProd${i}`]?.nodes ?? [];
      if (!nodes.length) diagnostics.excludeMissingProductTags.push(tag);
    });

    // Missing tags (customers)
    excludedCustomerCapped.forEach((tag, i) => {
      const nodes: any[] = res?.[`excCust${i}`]?.nodes ?? [];
      if (!nodes.length) diagnostics.excludedCustomerMissingTags.push(tag);
    });

    if (includeProductTags.length > 0 && diagnostics.includeMissingProductTags.length > 0) {
      diagnostics.warnings.push(
        `Some include product tags are not present on ANY products: ${diagnostics.includeMissingProductTags.join(", ")}.`,
      );
    }

    if (excludeProductTags.length > 0 && diagnostics.excludeMissingProductTags.length > 0) {
      diagnostics.notes.push(
        `Some exclude product tags are not present on any products (no effect): ${diagnostics.excludeMissingProductTags.join(
          ", ",
        )}.`,
      );
    }

    if (excludedCustomerTags.length > 0 && diagnostics.excludedCustomerMissingTags.length > 0) {
      diagnostics.warnings.push(
        `Some excluded customer tags are not present on ANY customers (possible typo / unused): ${diagnostics.excludedCustomerMissingTags.join(
          ", ",
        )}.`,
      );
    }

    if (effectiveProductQuery && includeProductTags.length > 0 && diagnostics.eligibleProductSample.length === 0) {
      diagnostics.warnings.push(
        "No eligible products found for the current product include/exclude tags. Earning and redemption will effectively be disabled.",
      );
    }
  } catch (e: any) {
    diagnostics.warnings.push(`Could not compute eligibility diagnostics: ${String(e?.message ?? e)}`);
  }

  return diagnostics;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await getShopSettings(shop);
  const diagnostics = await computeEligibilityDiagnostics(shop, settings);

  return data<LoaderData>({ shop, settings, diagnostics });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();

  try {
    const earnRate = clampInt(form.get("earnRate"), 1, 100);
    const redemptionMinOrder = clampInt(form.get("redemptionMinOrder"), 0, 100000);

    const excludedCustomerTags = normalizeTagList(csvToList(form.get("excludedCustomerTags")));
    const includeProductTags = normalizeTagList(csvToList(form.get("includeProductTags")));
    const excludeProductTags = normalizeTagList(csvToList(form.get("excludeProductTags")));

    // Enforce v1.1 hard redemption rule (fixed steps + fixed values)
    const redemptionSteps = [...V1_REDEMPTION_STEPS];
    const redemptionValueMap = { ...V1_REDEMPTION_VALUE_MAP };

    await db.shopSettings.upsert({
      where: { shop },
      create: {
        shop,
        earnRate,
        redemptionMinOrder,
        excludedCustomerTags,
        includeProductTags,
        excludeProductTags,
        redemptionSteps,
        redemptionValueMap,
      } as any,
      update: {
        earnRate,
        redemptionMinOrder,
        excludedCustomerTags,
        includeProductTags,
        excludeProductTags,
        redemptionSteps,
        redemptionValueMap,
        updatedAt: new Date(),
      } as any,
    });

    return data<ActionData>({ ok: true, message: "Settings saved." });
  } catch (e: any) {
    return data<ActionData>({ ok: false, error: String(e?.message ?? e) }, { status: 400 });
  }
};

export default function SettingsPage() {
  const { shop, settings, diagnostics } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();

  const hasWarnings = diagnostics.warnings.length > 0;
  const hasNotes = diagnostics.notes.length > 0;

  return (
    <div style={{ padding: 18, maxWidth: 980 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>Program Settings</h1>
        <Link to="/app" style={{ opacity: 0.8 }}>
          ← Back
        </Link>
      </div>

      <div style={{ opacity: 0.7, marginTop: 6, marginBottom: 14 }}>Shop: {shop}</div>

      {actionData ? (
        <div
          style={{
            border: `1px solid ${actionData.ok ? "#b7e4c7" : "#ffccd5"}`,
            background: actionData.ok ? "#ecfdf5" : "#fff1f2",
            padding: 12,
            borderRadius: 12,
            marginBottom: 14,
          }}
        >
          {actionData.ok ? actionData.message : actionData.error}
        </div>
      ) : null}

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Eligibility diagnostics</h2>

        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
          Checked: {new Date(diagnostics.computedAt).toLocaleString()}
        </div>

        {hasWarnings && (
          <div style={{ border: "1px solid #fecaca", background: "#fff1f2", padding: 12, borderRadius: 12, marginBottom: 10 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Warnings</div>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
              {diagnostics.warnings.map((w, idx) => (
                <li key={idx}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {hasNotes && (
          <div style={{ border: "1px solid #e5e5e5", background: "#fafafa", padding: 12, borderRadius: 12, marginBottom: 10 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Notes</div>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
              {diagnostics.notes.map((n, idx) => (
                <li key={idx}>{n}</li>
              ))}
            </ul>
          </div>
        )}

        {diagnostics.effectiveProductQuery ? (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Effective product query</div>
            <code
              style={{
                display: "block",
                padding: 10,
                borderRadius: 12,
                background: "#111827",
                color: "white",
                overflowX: "auto",
              }}
            >
              {diagnostics.effectiveProductQuery}
            </code>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
              This is the Shopify Admin product search expression used to determine eligible products.
            </div>
          </div>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div style={{ border: "1px dashed #e5e5e5", borderRadius: 12, padding: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Include product tags with 0 products</div>
            {diagnostics.includeMissingProductTags.length ? (
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                {diagnostics.includeMissingProductTags.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            ) : (
              <div style={{ opacity: 0.75 }}>None</div>
            )}
          </div>

          <div style={{ border: "1px dashed #e5e5e5", borderRadius: 12, padding: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Exclude product tags with 0 products</div>
            {diagnostics.excludeMissingProductTags.length ? (
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                {diagnostics.excludeMissingProductTags.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            ) : (
              <div style={{ opacity: 0.75 }}>None</div>
            )}
          </div>
        </div>

        <div style={{ border: "1px dashed #e5e5e5", borderRadius: 12, padding: 12, marginBottom: 10 }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>Excluded customer tags with 0 customers</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
            Helps catch typos/unexpected casing/spaces. If a tag shows here, it currently matches no customers.
          </div>
          {diagnostics.excludedCustomerTags.length === 0 ? (
            <div style={{ opacity: 0.75 }}>No excluded customer tags configured.</div>
          ) : diagnostics.excludedCustomerMissingTags.length ? (
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
              {diagnostics.excludedCustomerMissingTags.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : (
            <div style={{ opacity: 0.75 }}>None</div>
          )}
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
            Note: Shopify may restrict Customer object access for public apps without Protected Customer Data approval. If so, you’ll see a warning above.
          </div>
        </div>

        <div style={{ border: "1px dashed #e5e5e5", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>Eligible products (sample)</div>

          {diagnostics.effectiveProductQuery == null ? (
            <div style={{ opacity: 0.75 }}>All products are eligible (no product tag filters set).</div>
          ) : diagnostics.eligibleProductSample.length === 0 ? (
            <div style={{ opacity: 0.75 }}>No eligible products found with the current include/exclude tags.</div>
          ) : (
            <>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                {diagnostics.eligibleProductSample.map((p) => (
                  <li key={p.id}>
                    {p.title}
                    {p.handle ? <span style={{ opacity: 0.7 }}> ({p.handle})</span> : null}
                  </li>
                ))}
              </ul>
              {diagnostics.eligibleProductSampleHasMore ? (
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>More eligible products exist (sample limited to 5).</div>
              ) : null}
            </>
          )}
        </div>
      </section>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Program rules</h2>

        <Form method="post" style={{ display: "grid", gap: 12, maxWidth: 740 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Earn rate</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Points per $1 of <em>eligible net merchandise</em> on Paid orders.
            </span>
            <input name="earnRate" type="number" min={1} max={100} step={1} defaultValue={settings.earnRate} />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Minimum order subtotal to redeem (CAD)</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Applied to generated discount codes as a Shopify minimum-subtotal requirement.
            </span>
            <input name="redemptionMinOrder" type="number" min={0} max={100000} step={1} defaultValue={settings.redemptionMinOrder} />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Excluded customer tags</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Customers with any of these tags are excluded from earning and redemption.
            </span>
            <input name="excludedCustomerTags" type="text" placeholder="Wholesale, Staff" defaultValue={settings.excludedCustomerTags.join(", ")} />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Include product tags (optional)</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              If set, <strong>only</strong> products with at least one of these tags are eligible.
            </span>
            <input name="includeProductTags" type="text" placeholder="RewardsEligible" defaultValue={settings.includeProductTags.join(", ")} />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Exclude product tags (optional)</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Products with any of these tags are never eligible.
            </span>
            <input name="excludeProductTags" type="text" placeholder="NoRewards" defaultValue={settings.excludeProductTags.join(", ")} />
          </label>

          <button type="submit" style={{ width: 180 }}>
            Save Settings
          </button>
        </Form>
      </section>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
        <h2 style={{ marginTop: 0 }}>Redemption rules (v1.1 fixed)</h2>
        <div style={{ border: "1px dashed #e5e5e5", borderRadius: 12, padding: 12 }}>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            {V1_REDEMPTION_STEPS.map((pts) => (
              <li key={pts}>
                {pts} points → ${Number(V1_REDEMPTION_VALUE_MAP[String(pts)] ?? 0).toFixed(0)} off
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
            Max redeemable per order in v1.1 is {Math.max(...V1_REDEMPTION_STEPS)} points.
          </div>
        </div>
      </section>
    </div>
  );
}
