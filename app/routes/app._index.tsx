import type { LoaderFunctionArgs } from "react-router";
import { data, Link, useLoaderData, useLocation } from "react-router";
import { Page, Layout, Card, Text, BlockStack, InlineStack, Badge, Banner } from "@shopify/polaris";
import db from "../db.server";
import { requireAdmin } from "../lib/shopify.server";
import { getOrCreateShopSettings } from "../lib/shopSettings.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireAdmin(request);
  const shop = session.shop;

  const [settings, customerCount, redemptionCount, unprocessedWebhooks, lastWebhook, latestBackfillRun] = await Promise.all([
    getOrCreateShopSettings(shop),
    db.customerPointsBalance.count({ where: { shop } }),
    db.redemption.count({ where: { shop } }),
    db.webhookEvent.count({ where: { shop, processedAt: null } }),
    db.webhookEvent.findFirst({ where: { shop }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true, outcome: true } }),
    (db as any).historicalBackfillRun?.findFirst?.({ where: { shop }, orderBy: { createdAt: "desc" } }) ?? null,
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
    historicalBackfillEnabled: settings.historicalBackfillEnabled,
    historicalBackfillStartDate: settings.historicalBackfillStartDate,
    historicalBackfillLastRunAt: settings.historicalBackfillLastRunAt,
    historicalBackfillLastStatus: settings.historicalBackfillLastStatus,
    historicalBackfillLastSummary: settings.historicalBackfillLastSummary,
    latestBackfillRun,
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
    excludedCollectionsCount,
    excludedProductsCount,
    historicalBackfillEnabled,
    historicalBackfillStartDate,
    historicalBackfillLastRunAt,
    historicalBackfillLastStatus,
    historicalBackfillLastSummary,
  } = useLoaderData<typeof loader>();

  const { search } = useLocation();
  const withSearch = (path: string) => (search ? `${path}${search}` : path);

  const backfillTone =
    historicalBackfillLastStatus === "FAILED"
      ? "critical"
      : historicalBackfillLastStatus === "COMPLETED"
        ? "success"
        : historicalBackfillEnabled
          ? "info"
          : "attention";

  return (
    <Page title="Lions Creek Rewards">
      <Layout>
        <Layout.Section>
          {!historicalBackfillLastRunAt ? (
            <Banner
              tone="info"
              title="Optional v1.12 historical backfill is available"
              action={{ content: "Open Setup", url: withSearch("/app/setup") }}
            >
              Configure a merchant-selected historical start date and optionally backfill paid order history through today to retroactively calculate points and tier position.
            </Banner>
          ) : null}
        </Layout.Section>

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
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Historical backfill (v1.12)</Text>
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone={backfillTone as any}>{historicalBackfillLastStatus || (historicalBackfillEnabled ? "Configured" : "Optional")}</Badge>
                  <Badge tone={historicalBackfillStartDate ? "info" : "attention"}>{historicalBackfillStartDate ? `From ${historicalBackfillStartDate.slice(0, 10)}` : "No start date"}</Badge>
                </InlineStack>
              </InlineStack>
              <Text as="p" tone="subdued">
                Use <Link to={withSearch("/app/setup")}>Setup</Link> to store an optional installation backfill date and retroactively work through historical paid orders to calculate customer points and tier progression.
              </Text>
              {historicalBackfillLastRunAt ? (
                <BlockStack gap="200">
                  <InlineStack align="space-between"><Text as="p">Last backfill run</Text><Text as="p">{new Date(historicalBackfillLastRunAt).toLocaleString()}</Text></InlineStack>
                  <InlineStack align="space-between"><Text as="p">Orders scanned</Text><Text as="p" variant="headingMd">{Number(historicalBackfillLastSummary?.ordersScanned ?? 0)}</Text></InlineStack>
                  <InlineStack align="space-between"><Text as="p">Points awarded</Text><Text as="p" variant="headingMd">{Number(historicalBackfillLastSummary?.pointsAwarded ?? 0)}</Text></InlineStack>
                  <InlineStack align="space-between"><Text as="p">Refund reversals processed</Text><Text as="p" variant="headingMd">{Number(historicalBackfillLastSummary?.refundsProcessed ?? 0)}</Text></InlineStack>
                </BlockStack>
              ) : null}
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
                <Text as="p" tone="subdued">Open <Link to={withSearch("/app/settings")}>Settings</Link> to set earn rate, redemption mapping, tiers, and optional exclusions. If you set a discount-scope collection handle, redemption codes will apply only to that collection.</Text>

                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p">Exclusions configured</Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={excludedCollectionsCount > 0 ? "attention" : "success"}>{excludedCollectionsCount} collection(s)</Badge>
                    <Badge tone={excludedProductsCount > 0 ? "attention" : "success"}>{excludedProductsCount} product(s)</Badge>
                  </InlineStack>
                </InlineStack>

                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p">2) Optional historical backfill</Text>
                  <Badge tone={historicalBackfillLastRunAt ? "success" : historicalBackfillEnabled ? "info" : "attention"}>{historicalBackfillLastRunAt ? "Completed" : historicalBackfillEnabled ? "Configured" : "Optional"}</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">Open <Link to={withSearch("/app/setup")}>Setup</Link> if you want to backfill historical orders from a chosen start date through today and retroactively calculate points/tier standing.</Text>

                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p">3) Enable customer account extension</Text>
                  <Badge tone="info">Manual check</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">Ensure the extension setting <b>App Base URL</b> points to the correct environment (dev tunnel vs production domain).</Text>

                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p">4) Verify webhooks</Text>
                  <Badge tone={unprocessedWebhooks > 0 ? "attention" : "success"}>{unprocessedWebhooks > 0 ? "Queue" : "OK"}</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">Use <Link to={withSearch("/app/webhooks")}>Webhooks</Link> to confirm events are being processed and investigate failures.</Text>

                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p">5) Schedule expiry job</Text>
                  <Badge tone="info">Manual check</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">Schedule a local call to <code>GET /jobs/expire?all=1</code> using your <code>JOB_TOKEN</code>.</Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
