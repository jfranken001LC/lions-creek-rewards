// app/routes/app.customers.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  Page,
  Card,
  Text,
  TextField,
  Button,
  InlineStack,
  BlockStack,
  DataTable,
  Banner,
  Divider,
} from "@shopify/polaris";
import db from "../db.server";
import { authenticate } from "../shopify.server";

type CustomerHit = {
  id: string; // GID
  customerId: string; // legacy numeric as string
  displayName: string;
  email?: string | null;
};

function gidToLegacyId(gid: string): string {
  const parts = String(gid).split("/");
  return parts[parts.length - 1] ?? "";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId")?.trim() ?? "";

  if (!customerId) {
    return data({
      shop: session.shop,
      selected: null as any,
    });
  }

  const balance = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop: session.shop, customerId } },
  });

  const ledger = await db.pointsLedger.findMany({
    where: { shop: session.shop, customerId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const redemptions = await db.redemption.findMany({
    where: { shop: session.shop, customerId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return data({
    shop: session.shop,
    selected: {
      customerId,
      balance,
      ledger,
      redemptions,
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");

  if (intent === "search") {
    const query = String(form.get("query") ?? "").trim();
    const customerId = String(form.get("customerId") ?? "").trim();

    // Allow direct lookup by numeric customerId without Shopify search
    if (customerId) {
      return data({ ok: true, hits: [] as CustomerHit[], directCustomerId: customerId });
    }

    if (!query) return data({ ok: false, error: "Enter a name/email/customer id to search." }, { status: 400 });

    // Shopify GraphQL customer search
    const accessToken = await db.session.findFirst({
      where: { shop: session.shop, isOnline: false },
      orderBy: { createdAt: "desc" },
      select: { accessToken: true },
    });

    if (!accessToken?.accessToken) {
      return data({ ok: false, error: "Missing offline token; reinstall or re-auth the app." }, { status: 500 });
    }

    const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION ?? "2026-01";
    const endpoint = `https://${session.shop}/admin/api/${apiVersion}/graphql.json`;

    // Search by name/email; if numeric provided, try id:NNN
    const looksNumeric = /^\d+$/.test(query);
    const search = looksNumeric ? `id:${query}` : query;

    const gql = `
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

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken.accessToken,
      },
      body: JSON.stringify({ query: gql, variables: { first: 20, query: search } }),
    });

    const json = (await resp.json()) as any;
    if (!resp.ok || json?.errors) {
      return data({ ok: false, error: json?.errors ? JSON.stringify(json.errors) : `HTTP ${resp.status}` }, { status: 500 });
    }

    const edges = json?.data?.customers?.edges ?? [];
    const hits: CustomerHit[] = edges.map((e: any) => {
      const gid = String(e?.node?.id ?? "");
      return {
        id: gid,
        customerId: gidToLegacyId(gid),
        displayName: String(e?.node?.displayName ?? ""),
        email: e?.node?.email ?? null,
      };
    });

    return data({ ok: true, hits, directCustomerId: null });
  }

  if (intent === "adjust") {
    const customerId = String(form.get("customerId") ?? "").trim();
    const deltaRaw = String(form.get("delta") ?? "").trim();
    const reason = String(form.get("reason") ?? "").trim();

    if (!customerId) return data({ ok: false, error: "Missing customerId." }, { status: 400 });
    if (!deltaRaw) return data({ ok: false, error: "Enter a delta (e.g., 50 or -50)." }, { status: 400 });
    if (!reason) return data({ ok: false, error: "Reason is required." }, { status: 400 });

    const delta = Math.trunc(Number(deltaRaw));
    if (!Number.isFinite(delta) || delta === 0) {
      return data({ ok: false, error: "Delta must be a non-zero integer." }, { status: 400 });
    }

    await db.$transaction(async (tx) => {
      const existing =
        (await tx.customerPointsBalance.findUnique({
          where: { shop_customerId: { shop: session.shop, customerId } },
        })) ??
        (await tx.customerPointsBalance.create({
          data: {
            shop: session.shop,
            customerId,
            balance: 0,
            lifetimeEarned: 0,
            lifetimeRedeemed: 0,
            lastActivityAt: null,
            expiredAt: null,
          },
        }));

      const next = Math.max(0, existing.balance + delta);
      const applied = next - existing.balance;
      if (applied === 0) return;

      await tx.pointsLedger.create({
        data: {
          shop: session.shop,
          customerId,
          type: "ADJUST" as any,
          delta: applied,
          source: "ADMIN",
          sourceId: crypto.randomUUID(),
          description: reason,
        },
      });

      await tx.customerPointsBalance.update({
        where: { shop_customerId: { shop: session.shop, customerId } },
        data: {
          balance: next,
          lastActivityAt: new Date(),
        },
      });
    });

    return data({ ok: true, adjustedCustomerId: customerId });
  }

  return data({ ok: false, error: "Unsupported action." }, { status: 400 });
};

export default function CustomersAdmin() {
  const ld = useLoaderData() as any;
  const ad = useActionData() as any;
  const nav = useNavigation();

  const busy = nav.state !== "idle";
  const selected = ld?.selected ?? null;

  const hits: CustomerHit[] = ad?.hits ?? [];
  const directCustomerId: string | null = ad?.directCustomerId ?? null;

  return (
    <Page title="Customers (Loyalty)">
      <BlockStack gap="400">
        {ad?.error ? (
          <Banner tone="critical">
            <p>{ad.error}</p>
          </Banner>
        ) : null}

        {ad?.ok && ad?.adjustedCustomerId ? (
          <Banner tone="success">
            <p>Adjustment applied for customerId {ad.adjustedCustomerId}.</p>
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Lookup
            </Text>

            <Form method="post">
              <input type="hidden" name="_intent" value="search" />
              <InlineStack gap="300" wrap>
                <TextField
                  label="Search (name/email) OR leave blank and use Customer ID"
                  name="query"
                  autoComplete="off"
                  disabled={busy}
                />
                <TextField
                  label="Customer ID (numeric)"
                  name="customerId"
                  autoComplete="off"
                  disabled={busy}
                />
                <Button submit variant="primary" disabled={busy}>
                  Search
                </Button>
              </InlineStack>
            </Form>

            {directCustomerId ? (
              <Banner tone="info">
                <p>
                  Direct lookup requested.{" "}
                  <Link to={`/app/customers?customerId=${encodeURIComponent(directCustomerId)}`}>
                    View customerId {directCustomerId}
                  </Link>
                </p>
              </Banner>
            ) : null}

            {hits.length ? (
              <>
                <Divider />
                <Text as="h3" variant="headingSm">
                  Results
                </Text>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text"]}
                  headings={["Customer ID", "Display Name", "Email", "Actions"]}
                  rows={hits.map((h) => [
                    h.customerId,
                    h.displayName,
                    h.email ?? "",
                    <Link key={h.customerId} to={`/app/customers?customerId=${encodeURIComponent(h.customerId)}`}>
                      View
                    </Link>,
                  ])}
                />
              </>
            ) : null}
          </BlockStack>
        </Card>

        {selected ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Customer {selected.customerId}
              </Text>

              <Text as="p" variant="bodyMd">
                Balance: <b>{selected.balance?.balance ?? 0}</b> points · Lifetime earned:{" "}
                <b>{selected.balance?.lifetimeEarned ?? 0}</b> · Lifetime redeemed:{" "}
                <b>{selected.balance?.lifetimeRedeemed ?? 0}</b>
              </Text>

              <Divider />

              <Text as="h3" variant="headingSm">
                Manual adjustment (FR-4.3)
              </Text>

              <Form method="post">
                <input type="hidden" name="_intent" value="adjust" />
                <input type="hidden" name="customerId" value={selected.customerId} />
                <InlineStack gap="300" wrap>
                  <TextField
                    label="Delta (positive or negative)"
                    name="delta"
                    autoComplete="off"
                    disabled={busy}
                    helpText="Example: 50 adds 50 points, -50 removes 50 points. Balance will never go below 0."
                  />
                  <TextField
                    label="Reason"
                    name="reason"
                    autoComplete="off"
                    disabled={busy}
                  />
                  <Button submit variant="primary" disabled={busy}>
                    Apply
                  </Button>
                </InlineStack>
              </Form>

              <Divider />

              <Text as="h3" variant="headingSm">
                Ledger (last 100) (FR-4.4)
              </Text>

              <DataTable
                columnContentTypes={["text", "text", "numeric", "text", "text"]}
                headings={["When", "Type", "Delta", "Source", "Description"]}
                rows={(selected.ledger ?? []).map((l: any) => [
                  new Date(l.createdAt).toLocaleString(),
                  String(l.type),
                  String(l.delta),
                  `${l.source}:${l.sourceId}`,
                  l.description,
                ])}
              />

              <Divider />

              <Text as="h3" variant="headingSm">
                Redemptions (last 50)
              </Text>

              <DataTable
                columnContentTypes={["text", "text", "numeric", "numeric", "text"]}
                headings={["Issued", "Code", "Value", "Points", "Status"]}
                rows={(selected.redemptions ?? []).map((r: any) => [
                  new Date(r.createdAt).toLocaleString(),
                  r.code,
                  String(r.value),
                  String(r.points),
                  String(r.status),
                ])}
              />
            </BlockStack>
          </Card>
        ) : null}
      </BlockStack>
    </Page>
  );
}
