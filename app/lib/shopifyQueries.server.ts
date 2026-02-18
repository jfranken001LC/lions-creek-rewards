import db from "../db.server";
import type { ShopSettingsNormalized } from "./shopSettings.server";

export type AdminGraphql = (query: string, args?: { variables?: Record<string, any> }) => Promise<Response>;

const CUSTOMER_TAGS_QUERY = `#graphql
  query CustomerTags($id: ID!) {
    customer(id: $id) { id tags }
  }
`;

const COLLECTION_BY_HANDLE_QUERY = `#graphql
  query CollectionByHandle($handle: String!) {
    collectionByHandle(handle: $handle) { id handle title }
  }
`;

function toCustomerGid(customerIdOrGid: string): string {
  const s = String(customerIdOrGid || "").trim();
  if (!s) return "";
  if (s.startsWith("gid://")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Customer/${s}`;
  const m = s.match(/Customer\/(\d+)/i);
  if (m) return `gid://shopify/Customer/${m[1]}`;
  return s;
}

async function graphqlJson(res: Response): Promise<any> {
  const text = await res.text().catch(() => "");
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok) throw new Error(`Shopify GraphQL failed: ${res.status} ${res.statusText} ${text}`);
  if (json?.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json?.data ?? null;
}

export async function fetchCustomerTags(adminGraphql: AdminGraphql, customerIdOrGid: string): Promise<string[]> {
  const gid = toCustomerGid(customerIdOrGid);
  if (!gid) return [];
  const data = await graphqlJson(await adminGraphql(CUSTOMER_TAGS_QUERY, { variables: { id: gid } }));
  const tags = data?.customer?.tags;
  return Array.isArray(tags) ? tags.map((t: any) => String(t)) : [];
}

export async function fetchCollectionGidByHandle(
  adminGraphql: AdminGraphql,
  handle: string,
): Promise<{ id: string; title: string } | null> {
  const h = String(handle || "").trim();
  if (!h) return null;

  const data = await graphqlJson(await adminGraphql(COLLECTION_BY_HANDLE_QUERY, { variables: { handle: h } }));
  const col = data?.collectionByHandle;
  if (!col?.id) return null;
  return { id: String(col.id), title: String(col.title ?? "") };
}

export async function resolveEligibleCollectionGid(
  adminGraphql: AdminGraphql,
  shop: string,
  settings: Pick<ShopSettingsNormalized, "eligibleCollectionHandle" | "eligibleCollectionGid">,
): Promise<string> {
  const handle = String(settings.eligibleCollectionHandle || "").trim();
  if (!handle) throw new Error("Eligible collection handle is empty.");

  if (settings.eligibleCollectionGid) return settings.eligibleCollectionGid;

  const found = await fetchCollectionGidByHandle(adminGraphql, handle);
  if (!found) throw new Error(`Eligible collection not found for handle "${handle}".`);

  await db.shopSettings.upsert({
    where: { shop },
    create: { shop, eligibleCollectionHandle: handle, eligibleCollectionGid: found.id } as any,
    update: { eligibleCollectionHandle: handle, eligibleCollectionGid: found.id } as any,
  });

  return found.id;
}
