import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";
import { Page, Layout, Card, IndexTable, Text, Badge, BlockStack } from "@shopify/polaris";
import db from "../db.server";
import { requireAdmin } from "../lib/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireAdmin(request);
  const shop = session.shop;

  const redemptions = await db.redemption.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 250,
    select: { id: true, customerId: true, code: true, points: true, value: true, status: true, createdAt: true, expiresAt: true, orderId: true },
  });

  return data({
    rows: redemptions.map((r) => ({
      ...r,
      status: String(r.status),
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    })),
  });
}

function tone(status: string) {
  switch (status) {
    case "CONSUMED": return "success";
    case "ISSUED": return "info";
    case "APPLIED": return "attention";
    case "EXPIRED": return "warning";
    case "VOID":
    case "CANCELLED": return "critical";
    default: return "info";
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
                  { title: "Status" }, { title: "Customer" }, { title: "Code" },
                  { title: "Points" }, { title: "Value" }, { title: "Issued" },
                  { title: "Expires" }, { title: "Order" },
                ]}
              >
                {rows.map((r, idx) => (
                  <IndexTable.Row id={r.id} key={r.id} position={idx}>
                    <IndexTable.Cell><Badge tone={tone(r.status)}>{r.status}</Badge></IndexTable.Cell>
                    <IndexTable.Cell>{r.customerId}</IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" variant="bodyMd" fontWeight="semibold">{r.code}</Text></IndexTable.Cell>
                    <IndexTable.Cell>{r.points}</IndexTable.Cell>
                    <IndexTable.Cell>${Number(r.value).toFixed(2)}</IndexTable.Cell>
                    <IndexTable.Cell>{new Date(r.createdAt).toLocaleString()}</IndexTable.Cell>
                    <IndexTable.Cell>{new Date(r.expiresAt).toLocaleString()}</IndexTable.Cell>
                    <IndexTable.Cell>{r.orderId ?? ""}</IndexTable.Cell>
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
