import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, Link, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  getShopSettings,
  upsertShopSettings,
  V1_REDEMPTION_STEPS,
  V1_REDEMPTION_VALUE_MAP,
} from "../lib/shopSettings.server";

/**
 * Admin Program Settings
 * - Saves earning + eligibility settings
 * - Diagnostics:
 *   - Missing include/exclude product tags (tag not used by any products)
 *   - Effective eligibility preview (sample eligible products)
 *   - Overlap warning (same tag in include and exclude)
 *   - Customer excluded tag validation (tag not used by any customers)
 */

function csvToList(raw: FormDataEntryValue | null): string[] {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

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

type LoaderData = {
  shop: string;
  settings: Awaited<ReturnType<typeof getShopSettings>>;
  diagnostics: EligibilityDiagnostics;
};

function clampInt(n: any, min: number, max: number): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const s = await db.session.findUnique({ where: { id } }).catch(() => null);
  return s?.accessToken ?? null;
}

async function shopifyGraphql(shop: string, query: string, variables: any) {
  const token = await getOfflineAccessToken(shop);
  if (!token) throw new Error("Missing offline access token. Reinstall/re-auth the app.");

  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION ?? "2026-01";
  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json().catch(() => ({} as any));
  if (!resp.ok) throw new Error(`Shopify GraphQL HTTP ${resp.status}: ${JSON.stringify(json)}`);
  if (json.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
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
  // Shopify product search: tag:"My Tag"
  return `tag:${JSON.stringify(tag)}`;
}

function buildCustomerTagTerm(tag: string): string {
  // Shopify customer search supports tag:"My Tag" as well
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

async function computeEligibilityDiagnostics({
  shop,
  includeProductTagsRaw,
  excludeProductTagsRaw,
  excludedCustomerTagsRaw,
}: {
  shop: string;
  includeProductTagsRaw: string[];
  excludeProductTagsRaw: string[];
  excludedCustomerTagsRaw: string[];
}): Promise<EligibilityDiagnostics> {
  const includeProductTags = normalizeTagList(includeProductTagsRaw);
  const excludeProductTags = normalizeTagList(excludeProductTagsRaw);
  const excludedCustomerTags = normalizeTagList(excludedCustomerTagsRaw);

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

  // Configuration-derived notes
  if (!effectiveProductQuery) {
    diagnostics.notes.push("No product tag filters set: all products are eligible for earning/redemption.");
  } else if (includeProductTags.length > 0 && excludeProductTags.length === 0) {
    diagnostics.notes.push("Include tags set: only products with at least one include tag are eligible.");
  } else if (includeProductTags.length === 0 && excludeProductTags.length > 0) {
    diagnostics.notes.push("Exclude tags set: all products are eligible except those with an excluded tag.");
  } else {
    diagnostics.notes.push(
      "Include + exclude tags set: eligible products must match include tags and must NOT match excluded tags.",
    );
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

  // Decide whether to run Shopify checks
  const needsShopifyChecks = Boolean(effectiveProductQuery) || excludedCustomerTags.length > 0;
  if (!needsShopifyChecks) return diagnostics;

  // Cap to keep query bounded
  const includeCapped = includeProductTags.slice(0, 20);
  const excludeCapped = excludeProductTags.slice(0, 20);
  const excludedCustomerCapped = excludedCustomerTags.slice(0, 20);

  const varDefs: string[] = [];
  const varVals: Record<string, string> = {};
  const fieldLines: string[] = [];

  // Eligible product sample only if we have product constraints
  if (effectiveProductQuery) {
    varDefs.push(`$qEligibleProducts: String!`);
    varVals["qEligibleProducts"] = effectiveProductQuery;
    fieldLines.push(`
      eligibleProducts: products(first: 5, query: $qEligibleProducts) {
        pageInfo { hasNextPage }
        nodes { id title handle }
      }
    `);
  }

  // Product include tag existence
  includeCapped.forEach((tag, i) => {
    const v = `qIncProd${i}`;
    varDefs.push(`$${v}: String!`);
    varVals[v] = buildProductTagTerm(tag);
    fieldLines.push(`
      incProd${i}: products(first: 1, query: $${v}) { nodes { id } }
    `);
  });

  // Product exclude tag existence
  excludeCapped.forEach((tag, i) => {
    const v = `qExcProd${i}`;
    varDefs.push(`$${v}: String!`);
    varVals[v] = buildProductTagTerm(tag);
    fieldLines.push(`
      excProd${i}: products(first: 1, query: $${v}) { nodes { id } }
    `);
  });

  // Customer excluded tag existence
  excludedCustomerCapped.forEach((tag, i) => {
    const v = `qExcCust${i}`;
    varDefs.push(`$${v}: String!`);
    varVals[v] = buildCustomerTagTerm(tag);
    fieldLines.push(`
      excCust${i}: customers(first: 1, query: $${v}) { nodes { id } }
    `);
  });

  const query = `
    query EligibilityDiagnostics(${varDefs.join(", ")}) {
      ${fieldLines.join("\n")}
    }
  `;

  try {
    const data = await shopifyGraphql(shop, query, varVals);

    // Eligible product sample
    if (effectiveProductQuery) {
      const eligibleNodes: any[] = data?.eligibleProducts?.nodes ?? [];
      diagnostics.eligibleProductSample = eligibleNodes.map((n) => ({
        id: String(n?.id ?? ""),
        title: String(n?.title ?? ""),
        handle: n?.handle ? String(n.handle) : null,
      }));
      diagnostics.eligibleProductSampleHasMore = Boolean(data?.eligibleProducts?.pageInfo?.hasNextPage);
    }

    // Missing include product tags
    includeCapped.forEach((tag, i) => {
      const nodes: any[] = data?.[`incProd${i}`]?.nodes ?? [];
      if (!nodes.length) diagnostics.includeMissingProductTags.push(tag);
    });

    // Missing exclude product tags (informational)
    excludeCapped.forEach((tag, i) => {
      const nodes: any[] = data?.[`excProd${i}`]?.nodes ?? [];
      if (!nodes.length) diagnostics.excludeMissingProductTags.push(tag);
    });

    // Missing excluded customer tags (informational but important for typo detection)
    excludedCustomerCapped.forEach((tag, i) => {
      const nodes: any[] = data?.[`excCust${i}`]?.nodes ?? [];
      if (!nodes.length) diagnostics.excludedCustomerMissingTags.push(tag);
    });

    // Warnings based on reality
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

  const diagnostics = await computeEligibilityDiagnostics({
    shop,
    includeProductTagsRaw: settings.includeProductTags ?? [],
    excludeProductTagsRaw: settings.excludeProductTags ?? [],
    excludedCustomerTagsRaw: settings.excludedCustomerTags ?? [],
  });

  return data<LoaderData>({ shop, settings, diagnostics });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();

  const earnRate = Number(form.get("earnRate") ?? 1);
  const redemptionMinOrder = Number(form.get("redemptionMinOrder") ?? 0);

  try {
    await upsertShopSettings(shop, {
      earnRate: clampInt(earnRate, 1, 100),
      redemptionMinOrder: clampInt(redemptionMinOrder, 0, 100000),
      excludedCustomerTags: csvToList(form.get("excludedCustomerTags")),
      includeProductTags: csvToList(form.get("includeProductTags")),
      excludeProductTags: csvToList(form.get("excludeProductTags")),
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

      {(hasWarnings || hasNotes || diagnostics.effectiveProductQuery) && (
        <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <h2 style={{ marginTop: 0 }}>Eligibility diagnostics</h2>

          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
            Checked: {new Date(diagnostics.computedAt).toLocaleString()}
          </div>

          {hasWarnings && (
            <div
              style={{
                border: "1px solid #fecaca",
                background: "#fff1f2",
                padding: 12,
                borderRadius: 12,
                marginBottom: 10,
              }}
            >
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Warnings</div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                {diagnostics.warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {hasNotes && (
            <div
              style={{
                border: "1px solid #e5e5e5",
                background: "#fafafa",
                padding: 12,
                borderRadius: 12,
                marginBottom: 10,
              }}
            >
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
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                    More eligible products exist (sample limited to 5).
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>
      )}

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Earning rules</h2>

        <Form method="post" style={{ display: "grid", gap: 12, maxWidth: 740 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Earn rate</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Points per $1 of <em>eligible net merchandise</em> on Paid orders. v1 is typically 1.
            </span>
            <input name="earnRate" type="number" min={1} max={100} step={1} defaultValue={settings.earnRate} />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Excluded customer tags</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Customers with any of these tags are excluded from earning and redemption.
            </span>
            <input
              name="excludedCustomerTags"
              type="text"
              placeholder="Wholesale, Staff"
              defaultValue={settings.excludedCustomerTags.join(", ")}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Include product tags (optional)</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              If set, <strong>only</strong> products with at least one of these tags are eligible.
            </span>
            <input
              name="includeProductTags"
              type="text"
              placeholder="RewardsEligible"
              defaultValue={settings.includeProductTags.join(", ")}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Exclude product tags (optional)</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Products with any of these tags are never eligible.
            </span>
            <input
              name="excludeProductTags"
              type="text"
              placeholder="NoRewards"
              defaultValue={settings.excludeProductTags.join(", ")}
            />
          </label>

          <button type="submit" style={{ width: 180 }}>
            Save Settings
          </button>
        </Form>
      </section>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
        <h2 style={{ marginTop: 0 }}>Redemption rules (v1)</h2>

        <Form method="post" style={{ display: "grid", gap: 12, maxWidth: 740 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Minimum order subtotal to redeem (CAD)</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Applied to generated discount codes as a Shopify minimum-subtotal requirement.
            </span>
            <input
              name="redemptionMinOrder"
              type="number"
              min={0}
              max={100000}
              step={1}
              defaultValue={settings.redemptionMinOrder}
            />
          </label>

          <div style={{ border: "1px dashed #e5e5e5", borderRadius: 12, padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Fixed redemption steps (hard-locked for v1)</div>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
              {V1_REDEMPTION_STEPS.map((pts) => (
                <li key={pts}>
                  {pts} points → ${V1_REDEMPTION_VALUE_MAP[String(pts)].toFixed(0)} off
                </li>
              ))}
            </ul>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
              Max redeemable per order in v1 is 1000 points.
            </div>
          </div>

          <button type="submit" style={{ width: 180 }}>
            Save Settings
          </button>
        </Form>
      </section>
    </div>
  );
}
