import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  Text,
  IndexTable,
  Badge,
} from "@shopify/polaris";
import { prisma } from "../lib/prisma.server";
import { requireAdmin } from "../lib/shopify.server";
import { formatIsoDateTimeLocal } from "../lib/time";

type RedemptionRow = {
  id: string;
  shop: string;
  customerId: string;
  orderId: string | null;
  pointsRedeemed: number;
  rewardType: string;
  rewardValue: string;
  createdAt: string;
  status: string;
};

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const redemptions = await prisma.redemption.findMany({
    orderBy: { createdAt: "desc" },
    take: 250,
  });

  // NOTE: don't name this "data" or it shadows the imported data() helper
  const rowsData: RedemptionRow[] = redemptions.map((r) => ({
    id: r.id,
    shop: r.shop,
    customerId: r.customerId,
    orderId: r.orderId,
    pointsRedeemed: r.pointsRedeemed,
    rewardType: r.rewardType,
    rewardValue: r.rewardValue,
    createdAt: r.createdAt.toISOString(),
    status: r.status,
  }));

  return data({ rows: rowsData });
}

export default function RedemptionsPage() {
  const { rows } = useLoaderData<typeof loader>();

  const resourceName = { singular: "redemption", plural: "redemptions" };

  const rowMarkup = rows.map((r, index) => {
    const tone =
      r.status === "APPLIED"
        ? "success"
        : r.status === "FAILED"
          ? "critical"
          : "warning";

    return (
      <IndexTable.Row id={r.id} key={r.id} position={index}>
        <IndexTable.Cell>
          <BlockStack gap="050">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {r.rewardType}
            </Text>
            <Text as="span" tone="subdued" variant="bodySm">
              {r.rewardValue}
            </Text>
          </BlockStack>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text as="span" variant="bodySm">
            {r.customerId}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text as="span" variant="bodySm">
            {r.orderId ?? "(none)"}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text as="span" variant="bodySm">
            {r.pointsRedeemed}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Badge tone={tone}>{r.status}</Badge>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text as="span" variant="bodySm">
            {formatIsoDateTimeLocal(r.createdAt)}
          </Text>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page title="Redemptions">
      <BlockStack gap="400">
        <Card padding="0">
          <IndexTable
            resourceName={resourceName}
            itemCount={rows.length}
            selectable={false}
            headings={[
              { title: "Reward" },
              { title: "Customer" },
              { title: "Order" },
              { title: "Points" },
              { title: "Status" },
              { title: "Created" },
            ]}
          >
            {rowMarkup}
          </IndexTable>
        </Card>
      </BlockStack>
    </Page>
  );
}
