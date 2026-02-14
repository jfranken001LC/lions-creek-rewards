// app/lib/shopifyQueries.server.ts
import db from "../db.server";

type AdminClient = {
  graphql: (query: string, args?: { variables?: Record<string, any> }) => Promise<Response>;
};

const CUSTOMER_TAGS_QUERY = `#graphql
  query CustomerTags($id: ID!) {
    customer(id: $id) {
      id
      tags
    }
  }
`;

const COLLECTION_BY_HANDLE_QUERY = `#graphql
  query CollectionByHandle($handle: String!) {
    collectionByHandle(handle: $handle) {
      id
      handle
      title
    }
  }
`;

export async function fetchCustomerTags(admin: AdminClient, customerGid: string): Promise<string[]> {
  const res = await admin.graphql(CUSTOMER_TAGS_QUERY, { variables: { id: customerGid } });
  const json = (await res.json()) as any;
  const tags = json?.data?.customer?.tags;
  return Array.isArray(tags) ? tags.map((t: any) => String(t)) : [];
}

export async function fetchCollectionGidByHandle(
  admin: AdminClient,
  handle: string,
): Promise<{ id: string; title: string } | null> {
  const res = await admin.graphql(COLLECTION_BY_HANDLE_QUERY, { variables: { handle } });
  const json = (await res.json()) as any;
  const col = json?.data?.collectionByHandle;
  if (!col?.id) return null;
  return { id: String(col.id), title: String(col.title ?? "") };
}

/**
 * Resolve + cache the eligible collection GID in ShopSettings.
 * This is required to ensure redemption discounts only apply to eligible merchandise.
 */
export async function resolveEligibleCollectionGid(args: {
  admin: AdminClient;
  shop: string;
  handle: string;
}): Promise<string> {
  const handle = args.handle.trim();
  if (!handle) throw new Error("Eligible collection handle is empty.");

  const row = await db.shopSettings.findUnique({ where: { shop: args.shop } }).catch(() => null);
  if (
    row?.eligibleCollectionGid &&
    row?.eligibleCollectionHandle?.trim().toLowerCase() === handle.toLowerCase()
  ) {
    return row.eligibleCollectionGid;
  }

  const found = await fetchCollectionGidByHandle(args.admin, handle);
  if (!found) {
    throw new Error(
      `Eligible collection not found for handle "${handle}". Create the collection or update Settings.`,
    );
  }

  await db.shopSettings.upsert({
    where: { shop: args.shop },
    create: { shop: args.shop, eligibleCollectionHandle: handle, eligibleCollectionGid: found.id } as any,
    update: { eligibleCollectionHandle: handle, eligibleCollectionGid: found.id } as any,
  });

  return found.id;
}
