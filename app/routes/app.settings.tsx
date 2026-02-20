import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, Link, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { apiVersion, authenticate } from "../shopify.server";
import type { ShopSettingsNormalized } from "../lib/shopSettings.server";

/**
 * Lions Creek Rewards — Admin Settings (canonical ShopSettings UI)
 *
 * Purpose:
 * - Admins can configure the loyalty program settings that back the canonical Prisma ShopSettings model:
 *   - eligible collection (handle + cached GID)
 *   - points expiry inactivity window
 *   - redemption expiry window
 *   - include/exclude product tags, excluded customer tags
 *   - earn rate + min order
 *   - redemption steps + value map
 *
 * Notes:
 * - This is primarily admin correctness + UX. Core runtime uses these settings, but some enforcement
 *   (e.g., eligible collection for earning) may be implemented elsewhere.
 * - Only loader/action do server work; the default component is UI only.
 */

type ActionData = { ok: true; message: string } | { ok: false; error: string };

type EligiblePreviewProduct = { id: string; title: string; handle: string | null };

type EligibilityDiagnostics = {
  computedAt: string;

  // Collection eligibility
  eligibleCollectionHandle: string;
  eligibleCollectionGid: string | null;
  eligibleCollectionTitle: string | null;
  eligibleCollectionFound: boolean;
  eligibleCollectionGidMismatch: boolean;

  // Product eligibility
  effectiveProductQuery: string | null;
  includeMissingProductTags: string[];
  excludeMissingProductTags: string[];
  overlapProductTags: string[];
  eligibleProductSample: EligiblePreviewProduct[];
  eligibleProductSampleHasMore: boolean;

  // Collection sample (sanity)
  collectionProductSample: EligiblePreviewProduct[];
  collectionProductSampleHasMore: boolean;

  // Customer exclusion
  excludedCustomerTags: string[];
  excludedCustomerMissingTags: string[];

  warnings: string[];
  notes: string[];
};

type LoaderData = {
  shop: string;
  settings: ShopSettingsNormalized;
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

function listToCsv(list: string[]): string {
  return (list ?? []).filter(Boolean).join(", ");
}

function normalizeTagList(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of list ?? []) {
    const s = String(t || "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function parseRedemptionSteps(raw: FormDataEntryValue | null, fallback: number[]): number[] {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;

  const nums = s
    .split(",")
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0);

  const uniq = Array.from(new Set(nums));
  uniq.sort((a, b) => a - b);

  // keep sane bounds for v1
  const bounded = uniq.filter((n) => n <= 200000).slice(0, 12);
  return bounded.length ? bounded : fallback;
}

function parseRedemptionValueMap(
  raw: FormDataEntryValue | null,
  fallback: Record<string, number>,
): Record<string, number> {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;

  try {
    const obj = JSON.parse(s);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return fallback;

    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) out[String(k)] = n;
    }
    return Object.keys(out).length ? out : fallback;
  } catch {
    return fallback;
  }
}

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const sess = await db.session.findUnique({ where: { id } }).catch(() => null);
  return sess?.accessToken ?? null;
}

async function shopifyGraphql(shop: string, query: string, variables: any) {
  const token = await getOfflineAccessToken(shop);
  if (!token) throw new Error("Missing offline access token for shop. Reinstall/re-auth the app.");

  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

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

function buildProductTagTerm(tag: string): string {
  // Shopify search syntax:
  // - 'tag:' matches exact tag
  // - wrap in quotes for spaces
  const t = String(tag || "").trim();
  if (!t) return "";
  if (/\s/.test(t)) return `tag:"${t.replace(/"/g, '\\"')}"`;
  return `tag:${t}`;
}

function buildCustomerTagTerm(tag: string): string {
  const t = String(tag || "").trim();
  if (!t) return "";
  if (/\s/.test(t)) return `tag:"${t.replace(/"/g, '\\"')}"`;
  return `tag:${t}`;
}

function buildEffectiveProductEligibilityQuery(includeTags: string[], excludeTags: string[]): string | null {
  const inc = includeTags.map(buildProductTagTerm).filter(Boolean);
  const exc = excludeTags.map(buildProductTagTerm).filter(Boolean);

  if (inc.length === 0 && exc.length === 0) return null;

  // Product search queries are "AND" by default.
  // Include rule: any include tag => (tag:A OR tag:B ...)
  // Exclude rule: -tag:X -tag:Y ...
  const includeClause = inc.length ? `(${inc.join(" OR ")})` : "";
  const excludeClause = exc.map((x) => `-${x}`).join(" ");

  const parts = [includeClause, excludeClause].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

async function computeEligibilityDiagnostics(shop: string, settings: ShopSettingsNormalized): Promise<EligibilityDiagnostics> {
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

    eligibleCollectionHandle: settings.eligibleCollectionHandle,
    eligibleCollectionGid: settings.eligibleCollectionGid,
    eligibleCollectionTitle: null,
    eligibleCollectionFound: false,
    eligibleCollectionGidMismatch: false,

    effectiveProductQuery,
    includeMissingProductTags: [],
    excludeMissingProductTags: [],
    overlapProductTags,
    eligibleProductSample: [],
    eligibleProductSampleHasMore: false,

    collectionProductSample: [],
    collectionProductSampleHasMore: false,

    excludedCustomerTags,
    excludedCustomerMissingTags: [],

    warnings: [],
    notes: [],
  };

  // Notes: tags
  if (!effectiveProductQuery) {
    diagnostics.notes.push("No product tag filters set: tag filter does not restrict earning/redemption.");
  } else if (includeProductTags.length > 0 && excludeProductTags.length === 0) {
    diagnostics.notes.push("Include tags set: only products with at least one include tag pass the tag filter.");
  } else if (includeProductTags.length === 0 && excludeProductTags.length > 0) {
    diagnostics.notes.push("Exclude tags set: all products pass the tag filter except those with an excluded tag.");
  } else {
    diagnostics.notes.push("Include + exclude tags set: must match include tags and must NOT match excluded tags.");
  }

  if (overlapProductTags.length > 0) {
    diagnostics.warnings.push(
      `Product tag overlap detected (same tag in include and exclude): ${overlapProductTags.join(", ")}. Exclude wins.`,
    );
  }

  // Notes: customers
  if (excludedCustomerTags.length === 0) {
    diagnostics.notes.push("No excluded customer tags set: all customers can earn/redeem.");
  } else {
    diagnostics.notes.push(
      `Excluded customer tags active: customers with any of these tags cannot earn/redeem (${excludedCustomerTags.join(
        ", ",
      )}).`,
    );
  }

  // Notes: collection
  if (!settings.eligibleCollectionHandle?.trim()) {
    diagnostics.warnings.push("Eligible collection handle is empty. Redemption issuance will fail until set.");
  } else {
    diagnostics.notes.push(`Eligible collection handle: "${settings.eligibleCollectionHandle}".`);
    if (!settings.eligibleCollectionGid) {
      diagnostics.notes.push("Eligible collection GID is not cached yet; it will be resolved when needed.");
    }
  }

  // Remote checks are "best effort" and should not break the settings page.
  const needsRemoteChecks =
    Boolean(settings.eligibleCollectionHandle?.trim()) || Boolean(effectiveProductQuery) || excludedCustomerTags.length > 0;

  if (!needsRemoteChecks) return diagnostics;

  // Cap to keep query bounded
  const includeCapped = includeProductTags.slice(0, 20);
  const excludeCapped = excludeProductTags.slice(0, 20);
  const excludedCustomerCapped = excludedCustomerTags.slice(0, 20);

  const varDefs: string[] = [];
  const varVals: Record<string, any> = {};
  const fieldLines: string[] = [];

  // Collection by handle (sanity)
  if (settings.eligibleCollectionHandle?.trim()) {
    varDefs.push(`$collectionHandle: String!`);
    varVals.collectionHandle = settings.eligibleCollectionHandle.trim();
    fieldLines.push(`
      eligibleCollection: collectionByHandle(handle: $collectionHandle) {
        id
        handle
        title
        products(first: 5) {
          pageInfo { hasNextPage }
          nodes { id title handle }
        }
      }
    `);
  }

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

    // Collection sanity
    const col = res?.eligibleCollection ?? null;
    if (col?.id) {
      diagnostics.eligibleCollectionFound = true;
      diagnostics.eligibleCollectionTitle = String(col.title ?? "");
      const foundId = String(col.id);
      diagnostics.eligibleCollectionGidMismatch = Boolean(settings.eligibleCollectionGid && settings.eligibleCollectionGid !== foundId);

      const nodes: any[] = col?.products?.nodes ?? [];
      diagnostics.collectionProductSample = nodes.map((n) => ({
        id: String(n?.id ?? ""),
        title: String(n?.title ?? ""),
        handle: n?.handle ? String(n.handle) : null,
      }));
      diagnostics.collectionProductSampleHasMore = Boolean(col?.products?.pageInfo?.hasNextPage);

      if (diagnostics.eligibleCollectionGidMismatch) {
        diagnostics.warnings.push(
          "Eligible collection GID in settings does not match the current collectionByHandle result. Re-save settings to refresh the cached GID.",
        );
      }
    } else if (settings.eligibleCollectionHandle?.trim()) {
      diagnostics.warnings.push(
        `Eligible collection not found for handle "${settings.eligibleCollectionHandle}". Create the collection or fix the handle.`,
      );
    }

    // Eligible sample (tag-filter query)
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
        "No products found for the current tag filter query. Earning/redemption may effectively be disabled by tags.",
      );
    }
  } catch (e: any) {
    diagnostics.warnings.push(`Could not compute eligibility diagnostics: ${String(e?.message ?? e)}`);
  }

  return diagnostics;
}

const COLLECTION_BY_HANDLE_ONLY_QUERY = `#graphql
  query CollectionByHandle($handle: String!) {
    collectionByHandle(handle: $handle) { id title handle }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const { getOrCreateShopSettings } = await import("../lib/shopSettings.server");
  const settings = await getOrCreateShopSettings(shop);

  const diagnostics = await computeEligibilityDiagnostics(shop, settings);

  return data<LoaderData>({ shop, settings, diagnostics });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const { getOrCreateShopSettings, upsertShopSettings } = await import("../lib/shopSettings.server");
  const existing = await getOrCreateShopSettings(shop);

  const form = await request.formData();

  try {
    const earnRate = clampInt(form.get("earnRate"), 1, 100);
    const redemptionMinOrder = clampInt(form.get("redemptionMinOrder"), 0, 100000);

    const pointsExpireInactivityDays = clampInt(form.get("pointsExpireInactivityDays"), 1, 3650);
    const redemptionExpiryHours = clampInt(form.get("redemptionExpiryHours"), 1, 720);
    const preventMultipleActiveRedemptions = String(form.get("preventMultipleActiveRedemptions") ?? "") === "on";

    const excludedCustomerTags = normalizeTagList(csvToList(form.get("excludedCustomerTags")));
    const includeProductTags = normalizeTagList(csvToList(form.get("includeProductTags")));
    const excludeProductTags = normalizeTagList(csvToList(form.get("excludeProductTags")));

    const redemptionSteps = parseRedemptionSteps(form.get("redemptionSteps"), existing.redemptionSteps);
    const redemptionValueMap = parseRedemptionValueMap(form.get("redemptionValueMap"), existing.redemptionValueMap);

    // Collection handle/GID
    const eligibleCollectionHandleRaw = String(form.get("eligibleCollectionHandle") ?? "").trim();
    const eligibleCollectionHandle = eligibleCollectionHandleRaw || existing.eligibleCollectionHandle;

    const resolveCollectionNow = String(form.get("resolveCollectionNow") ?? "on") === "on";
    const submittedGid = String(form.get("eligibleCollectionGid") ?? "").trim() || null;

    const handleChanged = eligibleCollectionHandle !== existing.eligibleCollectionHandle;

    let eligibleCollectionGid: string | null = submittedGid;

    // If handle changed, never keep old cached gid unless we resolve it now.
    if (handleChanged) eligibleCollectionGid = null;

    if (resolveCollectionNow) {
      const res = await shopifyGraphql(shop, COLLECTION_BY_HANDLE_ONLY_QUERY, { handle: eligibleCollectionHandle });
      const col = res?.collectionByHandle ?? null;
      if (!col?.id) throw new Error(`Eligible collection not found for handle "${eligibleCollectionHandle}".`);
      eligibleCollectionGid = String(col.id);
    }

    await upsertShopSettings(shop, {
      earnRate,
      redemptionMinOrder,
      pointsExpireInactivityDays,
      redemptionExpiryHours,
      preventMultipleActiveRedemptions,
      eligibleCollectionHandle,
      eligibleCollectionGid,
      excludedCustomerTags,
      includeProductTags,
      excludeProductTags,
      redemptionSteps,
      redemptionValueMap,
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

      <Form method="post" style={{ display: "grid", gap: 14 }}>
        <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
          <h2 style={{ marginTop: 0 }}>Core</h2>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>Earn rate (points per $1 eligible net merchandise)</div>
              <input type="number" name="earnRate" defaultValue={settings.earnRate} min={1} max={100} />
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div>Redemption minimum order subtotal (cents)</div>
              <input type="number" name="redemptionMinOrder" defaultValue={settings.redemptionMinOrder} min={0} />
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div>Points expiry inactivity window (days)</div>
              <input
                type="number"
                name="pointsExpireInactivityDays"
                defaultValue={settings.pointsExpireInactivityDays}
                min={1}
                max={3650}
              />
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Points expire after this many days with no qualifying activity (earn or redeem).
              </div>
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div>Redemption code expiry (hours)</div>
              <input
                type="number"
                name="redemptionExpiryHours"
                defaultValue={settings.redemptionExpiryHours}
                min={1}
                max={720}
              />
              <div style={{ fontSize: 12, opacity: 0.75 }}>Issued discount codes expire after this many hours.</div>
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div>Prevent multiple active redemptions</div>
              <input
                type="checkbox"
                name="preventMultipleActiveRedemptions"
                defaultChecked={settings.preventMultipleActiveRedemptions}
              />
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                If enabled, a customer may only have one active redemption code at a time. Attempts to redeem again will
                return the existing active code.
              </div>
            </label>
          </div>
        </section>

        <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
          <h2 style={{ marginTop: 0 }}>Eligibility filters</h2>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>Eligible collection handle (required)</div>
              <input
                type="text"
                name="eligibleCollectionHandle"
                defaultValue={settings.eligibleCollectionHandle}
                placeholder="lcr_loyalty_eligible"
              />
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Collection used to scope redemptions (and earning, if enabled). Must exist in the shop.
              </div>
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div>Eligible collection GID (cached)</div>
              <input
                type="text"
                name="eligibleCollectionGid"
                defaultValue={settings.eligibleCollectionGid ?? ""}
                placeholder="gid://shopify/Collection/1234567890"
              />
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Normally auto-resolved from handle. Leave blank to auto-resolve on save.
              </div>
            </label>
          </div>

          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
            <input type="checkbox" name="resolveCollectionNow" defaultChecked />
            <span>Resolve + refresh collection GID from handle on save</span>
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>Excluded customer tags (comma-separated)</div>
              <textarea
                name="excludedCustomerTags"
                defaultValue={listToCsv(settings.excludedCustomerTags)}
                rows={3}
                placeholder="Wholesale"
              />
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Customers with any of these tags cannot earn or redeem.
              </div>
            </label>

            <div style={{ display: "grid", gap: 12 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <div>Include product tags (comma-separated)</div>
                <textarea name="includeProductTags" defaultValue={listToCsv(settings.includeProductTags)} rows={3} />
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  If set, a product must have at least one include tag (subject to exclude tags).
                </div>
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <div>Exclude product tags (comma-separated)</div>
                <textarea name="excludeProductTags" defaultValue={listToCsv(settings.excludeProductTags)} rows={3} />
                <div style={{ fontSize: 12, opacity: 0.75 }}>If set, any excluded tag makes a product ineligible.</div>
              </label>
            </div>
          </div>
        </section>

        <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
          <h2 style={{ marginTop: 0 }}>Redemption options</h2>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>Redemption steps (points, comma-separated)</div>
              <input type="text" name="redemptionSteps" defaultValue={settings.redemptionSteps.join(", ")} />
              <div style={{ fontSize: 12, opacity: 0.75 }}>Example: 500, 1000, 1500</div>
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div>Redemption value map (JSON: points → dollars)</div>
              <textarea
                name="redemptionValueMap"
                defaultValue={JSON.stringify(settings.redemptionValueMap, null, 2)}
                rows={6}
              />
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Keys must match the step values. Example: {"{"}"500": 10, "1000": 25{"}"}.
              </div>
            </label>
          </div>
        </section>

        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button
            type="submit"
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #222",
              background: "#111",
              color: "white",
              cursor: "pointer",
            }}
          >
            Save settings
          </button>
        </div>
      </Form>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginTop: 14 }}>
        <h2 style={{ marginTop: 0 }}>Diagnostics</h2>
        <div style={{ opacity: 0.7, fontSize: 12, marginBottom: 10 }}>Computed: {diagnostics.computedAt}</div>

        <div style={{ display: "grid", gap: 8 }}>
          <div>
            <b>Eligible collection</b>:{" "}
            {diagnostics.eligibleCollectionFound
              ? `${diagnostics.eligibleCollectionHandle} (${diagnostics.eligibleCollectionTitle ?? ""})`
              : diagnostics.eligibleCollectionHandle}
          </div>

          {diagnostics.eligibleCollectionFound ? (
            <div style={{ fontSize: 13, opacity: 0.85 }}>
              Collection sample:{" "}
              {diagnostics.collectionProductSample.length
                ? diagnostics.collectionProductSample.map((p) => p.title).join(", ") +
                  (diagnostics.collectionProductSampleHasMore ? " …" : "")
                : "(no products in collection sample)"}
            </div>
          ) : null}

          <div style={{ fontSize: 13, opacity: 0.85 }}>
            Tag filter query: {diagnostics.effectiveProductQuery ?? "(none)"}
          </div>

          {diagnostics.eligibleProductSample.length ? (
            <div style={{ fontSize: 13, opacity: 0.85 }}>
              Tag-filter sample:{" "}
              {diagnostics.eligibleProductSample.map((p) => p.title).join(", ")}
              {diagnostics.eligibleProductSampleHasMore ? " …" : ""}
            </div>
          ) : null}
        </div>

        {hasWarnings ? (
          <div style={{ marginTop: 12 }}>
            <h3 style={{ marginBottom: 6 }}>Warnings</h3>
            <ul style={{ marginTop: 0 }}>
              {diagnostics.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {hasNotes ? (
          <div style={{ marginTop: 12 }}>
            <h3 style={{ marginBottom: 6 }}>Notes</h3>
            <ul style={{ marginTop: 0 }}>
              {diagnostics.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}
