import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useSubmit } from "react-router";
import { useMemo, useState } from "react";
import { Page, Layout, Card, IndexTable, Text, Badge, BlockStack, InlineStack, TextField, Select, Button, Banner } from "@shopify/polaris";
import db from "../db.server";
import { requireAdmin } from "../lib/shopify.server";

type Row = {
  id: string;
  customerId: string;
  code: string;
  points: number;
  valueDollars: number;
  status: string;
  discountNodeId: string | null;
  createdAt: string;
  expiresAt: string | null;
  consumedOrderId: string | null;
  consumedAt: string | null;
  expiredAt: string | null;
  voidedAt: string | null;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireAdmin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const status = (url.searchParams.get("status") ?? "ALL").trim();

  const where: any = { shop };
  if (q) {
    where.OR = [
      { code: { contains: q } },
      { customerId: { contains: q } },
    ];
  }
  if (status !== "ALL") where.status = status;

  const redemptions = await db.redemption.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 250,
    select: {
      id: true,
      customerId: true,
      code: true,
      points: true,
      valueDollars: true,
      status: true,
      discountNodeId: true,
      createdAt: true,
      expiresAt: true,
      consumedOrderId: true,
      consumedAt: true,
      expiredAt: true,
      voidedAt: true,
    },
  });

  const rows: Row[] = redemptions.map((r) => ({
    id: r.id,
    customerId: r.customerId,
    code: r.code,
    points: r.points,
    valueDollars: r.valueDollars,
    status: String(r.status),
    discountNodeId: r.discountNodeId ?? null,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    consumedOrderId: r.consumedOrderId ?? null,
    consumedAt: r.consumedAt ? r.consumedAt.toISOString() : null,
    expiredAt: r.expiredAt ? r.expiredAt.toISOString() : null,
    voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
  }));

  return data({ shop, q, status, rows });
}

function tone(status: string) {
  switch (status) {
    case "CONSUMED":
      return "success";
    case "ISSUED":
      return "info";
    case "APPLIED":
      return "attention";
    case "EXPIRED":
      return "warning";
    case "VOID":
    case "CANCELLED":
      return "critical";
    default:
      return "info";
  }
}

export default function RedemptionsPage() {
  const { shop, q, status, rows } = useLoaderData<typeof loader>();
  const submit = useSubmit();

  const [search, setSearch] = useState(q ?? "");
  const [statusFilter, setStatusFilter] = useState(status ?? "ALL");
  const [copied, setCopied] = useState<string | null>(null);

  const statusOptions = useMemo(
    () => [
      { label: "All", value: "ALL" },
      { label: "ISSUED", value: "ISSUED" },
      { label: "APPLIED", value: "APPLIED" },
      { label: "CONSUMED", value: "CONSUMED" },
      { label: "EXPIRED", value: "EXPIRED" },
      { label: "VOID", value: "VOID" },
      { label: "CANCELLED", value: "CANCELLED" },
    ],
    [],
  );

  const runSearch = () => {
    const fd = new FormData();
    if (search.trim()) fd.set("q", search.trim());
    if (statusFilter && statusFilter !== "ALL") fd.set("status", statusFilter);
    submit(fd, { method: "get" });
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // ignore
    }
  };

  const discountIdFromGid = (gid: string | null) => {
    if (!gid) return null;
    const m = String(gid).match(/\/(\d+)$/);
    return m?.[1] ?? null;
  };

  return (
    <Page title="Redemptions">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {copied ? <Banner tone="success">Copied code: {copied}</Banner> : null}

              <InlineStack gap="200" align="start" blockAlign="end">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Search"
                    labelHidden
                    value={search}
                    onChange={setSearch}
                    placeholder="Search by code or customer ID"
                    autoComplete="off"
                  />
                </div>
                <Select label="Status" options={statusOptions} value={statusFilter} onChange={setStatusFilter} />
                <Button onClick={runSearch}>Search</Button>
              </InlineStack>

              <IndexTable
                resourceName={{ singular: "redemption", plural: "redemptions" }}
                itemCount={rows.length}
                selectable={false}
                headings={[
                  { title: "Status" },
                  { title: "Customer" },
                  { title: "Code" },
                  { title: "Points" },
                  { title: "Value" },
                  { title: "Issued" },
                  { title: "Expires" },
                  { title: "Consumed Order" },
                  { title: "" },
                ]}
              >
                {rows.map((r, idx) => (
                  <IndexTable.Row id={r.id} key={r.id} position={idx}>
                    <IndexTable.Cell>
                      <Badge tone={tone(r.status)}>{r.status}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodyMd">{r.customerId}</Text>
                        <Button size="micro" url={`https://${shop}/admin/customers/${encodeURIComponent(r.customerId)}`} external>Open</Button>
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {r.code}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{r.points}</IndexTable.Cell>
                    <IndexTable.Cell>${Number(r.valueDollars).toFixed(2)}</IndexTable.Cell>
                    <IndexTable.Cell>{new Date(r.createdAt).toLocaleString()}</IndexTable.Cell>
                    <IndexTable.Cell>{r.expiresAt ? new Date(r.expiresAt).toLocaleString() : ""}</IndexTable.Cell>
                    <IndexTable.Cell>{r.consumedOrderId ?? ""}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        <Button size="micro" onClick={() => copyCode(r.code)}>Copy</Button>
                        {discountIdFromGid(r.discountNodeId) ? (
                          <Button
                            size="micro"
                            url={`https://${shop}/admin/discounts/${discountIdFromGid(r.discountNodeId)}`}
                            external
                          >
                            Discount
                          </Button>
                        ) : null}
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
