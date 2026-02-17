import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";
import { Page, Layout, Card, Text, BlockStack, InlineStack, Badge } from "@shopify/polaris";
import db from "../db.server";
import { requireAdmin } from "../lib/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireAdmin(request);
  const shop = session.shop;

  const [customerCount, redemptionCount, unprocessedWebhooks] = await Promise.all([
    db.customerPointsBalance.count({ where: { shop } }),
    db.redemption.count({ where: { shop } }),
    db.webhookEvent.count({ where: { shop, processedAt: null } }),
  ]);

  return data({ shop, customerCount, redemptionCount, unprocessedWebhooks });
}

export default function AppIndex() {
  const { shop, customerCount, redemptionCount, unprocessedWebhooks } = useLoaderData<typeof loader>();

  return (
    <Page title="Lions Creek Rewards">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Store</Text>
                <Badge tone="info">{shop}</Badge>
              </InlineStack>
              <InlineStack align="space-between"><Text as="p">Tracked customers</Text><Text as="p" variant="headingLg">{customerCount}</Text></InlineStack>
              <InlineStack align="space-between"><Text as="p">Redemptions</Text><Text as="p" variant="headingLg">{redemptionCount}</Text></InlineStack>
              <InlineStack align="space-between"><Text as="p">Unprocessed webhook events</Text><Text as="p" variant="headingLg">{unprocessedWebhooks}</Text></InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
