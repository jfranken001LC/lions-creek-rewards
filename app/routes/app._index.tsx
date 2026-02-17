import type { LoaderFunctionArgs } from "react-router";
import { data, Link, useLoaderData } from "react-router";
import { Page, Card, BlockStack, Text } from "@shopify/polaris";
import { requireAdmin } from "../lib/shopify.server";
import { prisma } from "../lib/prisma.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const customerCount = await prisma.customer.count();
  const redemptionCount = await prisma.redemption.count();
  const unprocessedOrders = await prisma.orderEvent.count({
    where: { processedAt: null },
  });

  return data({
    customerCount,
    redemptionCount,
    unprocessedOrders,
  });
}

export default function AppIndex() {
  const { customerCount, redemptionCount, unprocessedOrders } =
    useLoaderData<typeof loader>();

  return (
    <Page title="Lions Creek Rewards">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Overview
            </Text>
            <Text as="p">Customers tracked: {customerCount}</Text>
            <Text as="p">Redemptions: {redemptionCount}</Text>
            <Text as="p">Unprocessed orders: {unprocessedOrders}</Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Quick links
            </Text>
            <Text as="p">
              <Link to="/app/customers">Customers</Link>
            </Text>
            <Text as="p">
              <Link to="/app/redemptions">Redemptions</Link>
            </Text>
            <Text as="p">
              <Link to="/app/settings">Settings</Link>
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
