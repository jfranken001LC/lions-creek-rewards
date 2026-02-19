import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";
import { Page, Layout, Card, IndexTable, Text, Badge, BlockStack } from "@shopify/polaris";
import db from "../db.server";
import { requireAdmin } from "../lib/shopify.server";

type Row = {
  id: string;
  customerId: string;
  code: string;
  points: number;
  valueDollars: number;
  status: string;
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

  const redemptions = await db.redemption.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 250,
    select: {
      id: true,
      customerId: true,
      code: true,
      points: true,
      valueDollars: true,
      status: true,
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
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    consumedOrderId: r.consumedOrderId ?? null,
    consumedAt: r.consumedAt ? r.consumedAt.toISOString() : null,
    expiredAt: r.expiredAt ? r.expiredAt.toISOString() : null,
    voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
  }));

  return data({ rows });
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
  const { rows } = useLoaderData<typeof loader>();

  return (
    <Page title="Redemptions">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
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
                ]}
              >
                {rows.map((r, idx) => (
                  <IndexTable.Row id={r.id} key={r.id} position={idx}>
                    <IndexTable.Cell>
                      <Badge tone={tone(r.status)}>{r.status}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{r.customerId}</IndexTable.Cell>
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
