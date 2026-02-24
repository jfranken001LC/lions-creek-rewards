import type { LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";
import { Page, Layout, Card, Text, BlockStack, InlineStack, Badge } from "@shopify/polaris";
import db from "../db.server";
import { requireAdmin } from "../lib/shopify.server";
import { getOrCreateShopSettings } from "../lib/shopSettings.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireAdmin(request);
  const shop = session.shop;

  const [settings, customerCount, redemptionCount, unprocessedWebhooks, lastWebhook] = await Promise.all([
    getOrCreateShopSettings(shop),
    db.customerPointsBalance.count({ where: { shop } }),
    db.redemption.count({ where: { shop } }),
    db.webhookEvent.count({ where: { shop, processedAt: null } }),
    db.webhookEvent.findFirst({ where: { shop }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true, outcome: true } }),
  ]);

  return data({
    shop,
    customerCount,
    redemptionCount,
    unprocessedWebhooks,
    lastWebhookAt: lastWebhook?.receivedAt ? lastWebhook.receivedAt.toISOString() : null,
    lastWebhookOutcome: lastWebhook?.outcome ? String(lastWebhook.outcome) : null,
    eligibleCollectionHandle: settings.eligibleCollectionHandle,
    eligibleCollectionGid: settings.eligibleCollectionGid,
    excludedCollectionsCount: settings.excludedCollectionHandles?.length ?? 0,
    excludedProductsCount: settings.excludedProductIds?.length ?? 0,
  });
}

export default function AppIndex() {
  const {
    shop,
    customerCount,
    redemptionCount,
    unprocessedWebhooks,
    lastWebhookAt,
    lastWebhookOutcome,
    eligibleCollectionHandle,
    eligibleCollectionGid,
    excludedCollectionsCount,
    excludedProductsCount,
  } = useLoaderData<typeof loader>();

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
              <InlineStack align="space-between">
                <Text as="p">Last webhook received</Text>
                <Text as="p" variant="bodyMd">
                  {lastWebhookAt ? new Date(lastWebhookAt).toLocaleString() : "(none)"}{" "}
                  {lastWebhookOutcome ? <Badge tone={lastWebhookOutcome === "FAILED" ? "critical" : lastWebhookOutcome === "PROCESSED" ? "success" : "info"}>{lastWebhookOutcome}</Badge> : null}
                </Text>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Getting started</Text>

              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p">1) Configure program settings</Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone="success">Ready</Badge>
                    <Badge tone={eligibleCollectionHandle?.trim() ? "info" : "success"}>{eligibleCollectionHandle?.trim() ? "Discount scope set" : "Discount scope: ALL"}</Badge>
                  </InlineStack>
                </InlineStack>
                <Text as="p" tone="subdued">Open <a href="/app/settings">Settings</a> to set earn rate, redemption mapping, and optional exclusions. If you set a discount-scope collection handle, redemption codes will apply only to that collection.</Text>

                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p">Exclusions configured</Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={excludedCollectionsCount > 0 ? "attention" : "success"}>{excludedCollectionsCount} collection(s)</Badge>
                    <Badge tone={excludedProductsCount > 0 ? "attention" : "success"}>{excludedProductsCount} product(s)</Badge>
                  </InlineStack>
                </InlineStack>

                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p">2) Enable customer account extension</Text>
                  <Badge tone="info">Manual check</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">Ensure the extension setting <b>App Base URL</b> points to the correct environment (dev tunnel vs production domain).</Text>

                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p">3) Verify webhooks</Text>
                  <Badge tone={unprocessedWebhooks > 0 ? "attention" : "success"}>{unprocessedWebhooks > 0 ? "Queue" : "OK"}</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">Use <a href="/app/webhooks">Webhooks</a> to confirm events are being processed and investigate failures.</Text>

                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p">4) Schedule expiry job</Text>
                  <Badge tone="info">Manual check</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">Schedule a daily call to <code>GET /jobs/expire</code> using your <code>JOB_TOKEN</code>.</Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
