import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";
import { getShopSettings } from "../lib/shopSettings.server";

function verifyAppProxyHmac(url: URL, secret: string): boolean {
  const signature = url.searchParams.get("signature") ?? "";
  if (!signature) return false;

  const sorted = [...url.searchParams.entries()]
    .filter(([k]) => k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b));

  const message = sorted.map(([k, v]) => `${k}=${v}`).join("");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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

async function getCustomerTags(shop: string, customerGid: string): Promise<{ tags: string[]; warning?: string | null }> {
  const query = `
    query CustomerTags($id: ID!) { customer(id: $id) { tags } }
  `;
  try {
    const data = await shopifyGraphql(shop, query, { id: customerGid });
    const tags: any[] = data?.customer?.tags ?? [];
    return { tags: Array.isArray(tags) ? tags.map((t) => String(t)) : [] };
  } catch (e: any) {
    return { tags: [], warning: String(e?.message ?? e) };
  }
}

function toCustomerGid(id: string) {
  const numeric = String(id ?? "").trim();
  return numeric ? `gid://shopify/Customer/${numeric}` : "";
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";

  const shop = (url.searchParams.get("shop") ?? "").toLowerCase();
  const customerId = url.searchParams.get("logged_in_customer_id") ?? "";
  const ok = verifyAppProxyHmac(url, apiSecret);

  if (!ok || !shop || !customerId) {
    return data({ ok: false }, { status: 401 });
  }

  const expiryMonths = 12;
  const settings = await getShopSettings(shop);

  const customerGid = toCustomerGid(customerId);
  const tagResult = customerGid ? await getCustomerTags(shop, customerGid) : { tags: [], warning: "Missing customer id" };
  const excludedTagList = settings.excludedCustomerTags ?? [];
  const customerExcluded = excludedTagList.some((t) => tagResult.tags.includes(t));
  const customerExcludedReason = customerExcluded
    ? `Excluded customer tag: ${excludedTagList.find((t) => tagResult.tags.includes(t))}`
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

  return data({
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

    redemptionMinOrder: Number(settings.redemptionMinOrder ?? 0) || 0,
    redemptionSteps: settings.redemptionSteps,
    redemptionValueMap: settings.redemptionValueMap,
    expiryMonths,
  });
};
