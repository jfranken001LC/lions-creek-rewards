import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, Link, useActionData, useLoaderData } from "react-router";
import React from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Checkbox,
  FormLayout,
  Button,
  Banner,
  List,
  Divider,
} from "@shopify/polaris";
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

function parseMoneyToCents(raw: FormDataEntryValue | null, fallbackCents: number): number {
  const s = String(raw ?? "").trim();
  if (!s) return fallbackCents;

  // Accept values like "25", "25.00", "$25", "1,234.56"
  const cleaned = s.replace(/[^0-9.\-]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return fallbackCents;

  // Keep v1 bounds sane
  const cents = Math.round(n * 100);
  return Math.max(0, Math.min(100000000, cents));
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
    // Stored as cents; UI submits dollars. Backwards-compatible with older "redemptionMinOrder" (cents) field.
    const redemptionMinOrder =
      form.get("redemptionMinOrderDollars") != null
        ? parseMoneyToCents(form.get("redemptionMinOrderDollars"), existing.redemptionMinOrder)
        : clampInt(form.get("redemptionMinOrder"), 0, 100000000);

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

    const resolveCollectionNow = String(form.get("resolveCollectionNow") ?? "") === "on";
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

  const [earnRate, setEarnRate] = React.useState(String(settings.earnRate));
  const [minOrderDollars, setMinOrderDollars] = React.useState(((settings.redemptionMinOrder ?? 0) / 100).toFixed(2));
  const [pointsExpireInactivityDays, setPointsExpireInactivityDays] = React.useState(String(settings.pointsExpireInactivityDays));
  const [redemptionExpiryHours, setRedemptionExpiryHours] = React.useState(String(settings.redemptionExpiryHours));
  const [preventMultipleActiveRedemptions, setPreventMultipleActiveRedemptions] = React.useState(Boolean(settings.preventMultipleActiveRedemptions));

  const [eligibleCollectionHandle, setEligibleCollectionHandle] = React.useState(settings.eligibleCollectionHandle ?? "");
  const [eligibleCollectionGid, setEligibleCollectionGid] = React.useState(settings.eligibleCollectionGid ?? "");
  const [resolveCollectionNow, setResolveCollectionNow] = React.useState(true);

  const [excludedCustomerTags, setExcludedCustomerTags] = React.useState(listToCsv(settings.excludedCustomerTags));
  const [includeProductTags, setIncludeProductTags] = React.useState(listToCsv(settings.includeProductTags));
  const [excludeProductTags, setExcludeProductTags] = React.useState(listToCsv(settings.excludeProductTags));

  const [redemptionSteps, setRedemptionSteps] = React.useState(settings.redemptionSteps.join(", "));
  const [redemptionValueMap, setRedemptionValueMap] = React.useState(JSON.stringify(settings.redemptionValueMap, null, 2));

  const hasWarnings = diagnostics.warnings.length > 0;
  const hasNotes = diagnostics.notes.length > 0;

  const collectionAdminUrl = eligibleCollectionHandle?.trim()
    ? `https://${shop}/admin/collections?query=${encodeURIComponent(eligibleCollectionHandle.trim())}`
    : `https://${shop}/admin/collections`;

  return (
    <Page
      title="Program Settings"
      subtitle={`Shop: ${shop}`}
      backAction={{ content: "Back", url: "/app" }}
      primaryAction={{ content: "Save", onAction: () => {
        const el = document.getElementById("settings-form") as HTMLFormElement | null;
        el?.requestSubmit();
      } }}
    >
      <Layout>
        <Layout.Section>
          {actionData ? (
            <Banner tone={actionData.ok ? "success" : "critical"} title={actionData.ok ? "Saved" : "Could not save"}>
              {actionData.ok ? actionData.message : actionData.error}
            </Banner>
          ) : null}

          {hasWarnings ? (
            <Banner tone="warning" title="Warnings">
              <List type="bullet">
                {diagnostics.warnings.map((w, i) => (
                  <List.Item key={i}>{w}</List.Item>
                ))}
              </List>
            </Banner>
          ) : null}

          {hasNotes ? (
            <Banner tone="info" title="Notes">
              <List type="bullet">
                {diagnostics.notes.map((n, i) => (
                  <List.Item key={i}>{n}</List.Item>
                ))}
              </List>
            </Banner>
          ) : null}
        </Layout.Section>

        <Layout.Section>
          <Form id="settings-form" method="post">
            <Layout>
              <Layout.Section>
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">Core</Text>

                    <FormLayout>
                      <TextField
                        label="Earn rate (points per $1 eligible net merchandise)"
                        type="number"
                        name="earnRate"
                        value={earnRate}
                        onChange={setEarnRate}
                        autoComplete="off"
                        min={"1"}
                        max={"100"}
                      />

                      <TextField
                        label="Minimum order subtotal to redeem ($)"
                        type="number"
                        name="redemptionMinOrderDollars"
                        value={minOrderDollars}
                        onChange={setMinOrderDollars}
                        autoComplete="off"
                        helpText="Example: 25.00 means a $25 minimum subtotal requirement on the discount code."
                      />

                      <InlineStack gap="400">
                        <div style={{ flex: 1 }}>
                          <TextField
                            label="Points expiry inactivity window (days)"
                            type="number"
                            name="pointsExpireInactivityDays"
                            value={pointsExpireInactivityDays}
                            onChange={setPointsExpireInactivityDays}
                            autoComplete="off"
                            min={"1"}
                            max={"3650"}
                            helpText="Points expire after this many days with no qualifying activity (earn or redeem)."
                          />
                        </div>

                        <div style={{ flex: 1 }}>
                          <TextField
                            label="Discount code expiry (hours)"
                            type="number"
                            name="redemptionExpiryHours"
                            value={redemptionExpiryHours}
                            onChange={setRedemptionExpiryHours}
                            autoComplete="off"
                            min={"1"}
                            max={"720"}
                            helpText="Issued discount codes expire after this many hours."
                          />
                        </div>
                      </InlineStack>

                      <Checkbox
                        label="Prevent multiple active redemptions"
                        name="preventMultipleActiveRedemptions"
                        checked={preventMultipleActiveRedemptions}
                        onChange={(checked) => setPreventMultipleActiveRedemptions(checked)}
                        helpText="If enabled, a customer may only have one active redemption code at a time. Redeeming again returns the existing active code."
                      />
                    </FormLayout>
                  </BlockStack>
                </Card>
              </Layout.Section>

              <Layout.Section>
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">Eligibility filters</Text>
                      <InlineStack gap="200">
                        <Button url={collectionAdminUrl} external>Open collections</Button>
                      </InlineStack>
                    </InlineStack>

                    <FormLayout>
                      <InlineStack gap="400">
                        <div style={{ flex: 1 }}>
                          <TextField
                            label="Eligible collection handle (required)"
                            name="eligibleCollectionHandle"
                            value={eligibleCollectionHandle}
                            onChange={setEligibleCollectionHandle}
                            autoComplete="off"
                            placeholder="lcr_loyalty_eligible"
                            helpText="Collection used to scope discount codes (and earning if enabled). Must exist in the shop."
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <TextField
                            label="Eligible collection GID (cached)"
                            name="eligibleCollectionGid"
                            value={eligibleCollectionGid}
                            onChange={setEligibleCollectionGid}
                            autoComplete="off"
                            helpText="Normally resolved from handle. Leave blank and save to auto-resolve."
                          />
                        </div>
                      </InlineStack>

                      <Checkbox
                        label="Resolve + refresh collection GID from handle on save"
                        name="resolveCollectionNow"
                        checked={resolveCollectionNow}
                        onChange={(checked) => setResolveCollectionNow(checked)}
                      />

                      <Divider />

                      <TextField
                        label="Excluded customer tags (comma-separated)"
                        name="excludedCustomerTags"
                        value={excludedCustomerTags}
                        onChange={setExcludedCustomerTags}
                        multiline={3}
                        autoComplete="off"
                        helpText="Customers with any of these tags cannot earn or redeem."
                        placeholder="Wholesale"
                      />

                      <InlineStack gap="400">
                        <div style={{ flex: 1 }}>
                          <TextField
                            label="Include product tags (comma-separated)"
                            name="includeProductTags"
                            value={includeProductTags}
                            onChange={setIncludeProductTags}
                            multiline={3}
                            autoComplete="off"
                            helpText="If set, a product must have at least one include tag (subject to exclude tags)."
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <TextField
                            label="Exclude product tags (comma-separated)"
                            name="excludeProductTags"
                            value={excludeProductTags}
                            onChange={setExcludeProductTags}
                            multiline={3}
                            autoComplete="off"
                            helpText="If set, any excluded tag makes a product ineligible."
                          />
                        </div>
                      </InlineStack>
                    </FormLayout>
                  </BlockStack>
                </Card>
              </Layout.Section>

              <Layout.Section>
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">Redemption options</Text>
                    <FormLayout>
                      <TextField
                        label="Redemption steps (points, comma-separated)"
                        name="redemptionSteps"
                        value={redemptionSteps}
                        onChange={setRedemptionSteps}
                        autoComplete="off"
                        helpText="Example: 500, 1000, 1500"
                      />
                      <TextField
                        label="Redemption value map (JSON: points → dollars)"
                        name="redemptionValueMap"
                        value={redemptionValueMap}
                        onChange={setRedemptionValueMap}
                        multiline={6}
                        autoComplete="off"
                        helpText='Keys must match the step values. Example: {"500": 10, "1000": 25}.'
                      />
                    </FormLayout>
                  </BlockStack>
                </Card>
              </Layout.Section>

              <Layout.Section>
                <Card>
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">Diagnostics</Text>
                      <Text as="span" tone="subdued">Computed: {diagnostics.computedAt}</Text>
                    </InlineStack>

                    <Text as="p" variant="bodyMd">
                      <b>Eligible collection</b>: {diagnostics.eligibleCollectionFound
                        ? `${diagnostics.eligibleCollectionHandle} (${diagnostics.eligibleCollectionTitle ?? ""})`
                        : diagnostics.eligibleCollectionHandle}
                    </Text>

                    {diagnostics.eligibleCollectionFound ? (
                      <Text as="p" tone="subdued">
                        Collection sample: {diagnostics.collectionProductSample.length
                          ? diagnostics.collectionProductSample.map((p) => p.title).join(", ") + (diagnostics.collectionProductSampleHasMore ? " …" : "")
                          : "(no products in sample)"}
                      </Text>
                    ) : null}

                    <Text as="p" tone="subdued">
                      Tag filter query: {diagnostics.effectiveProductQuery ?? "(none)"}
                    </Text>

                    {diagnostics.eligibleProductSample.length ? (
                      <Text as="p" tone="subdued">
                        Tag-filter sample: {diagnostics.eligibleProductSample.map((p) => p.title).join(", ")}{diagnostics.eligibleProductSampleHasMore ? " …" : ""}
                      </Text>
                    ) : null}
                  </BlockStack>
                </Card>
              </Layout.Section>
            </Layout>
          </Form>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
