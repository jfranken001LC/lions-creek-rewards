import type { LoaderFunctionArgs } from "react-router";
import { data, Link, useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  List,
  Banner,
  InlineStack,
  Badge,
} from "@shopify/polaris";

import db from "../db.server";
import { requireAdmin } from "../lib/shopify.server";
import { getOrCreateShopSettings } from "../lib/shopSettings.server";

type LoaderData = {
  shop: string;
  settings: {
    eligibleCollectionHandle: string;
    eligibleCollectionGid: string | null;
    earnRate: number;
    redemptionMinOrderCents: number;
    pointsExpireInactivityDays: number;
    redemptionExpiryHours: number;
    preventMultipleActiveRedemptions: boolean;
  };
  webhooks: {
    lastReceivedAt: string | null;
    failedLast24h: number;
    unprocessed: number;
  };
};

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireAdmin(request);
  const shop = session.shop;

  const settings = await getOrCreateShopSettings(shop);

  const [lastEvent, failedLast24h, unprocessed] = await Promise.all([
    db.webhookEvent.findFirst({
      where: { shop },
      orderBy: { receivedAt: "desc" },
      select: { receivedAt: true },
    }),
    db.webhookEvent.count({
      where: {
        shop,
        outcome: "FAILED",
        receivedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
    db.webhookEvent.count({ where: { shop, processedAt: null } }),
  ]);

  return data<LoaderData>({
    shop,
    settings: {
      eligibleCollectionHandle: settings.eligibleCollectionHandle,
      eligibleCollectionGid: settings.eligibleCollectionGid,
      earnRate: settings.earnRate,
      redemptionMinOrderCents: settings.redemptionMinOrder,
      pointsExpireInactivityDays: settings.pointsExpireInactivityDays,
      redemptionExpiryHours: settings.redemptionExpiryHours,
      preventMultipleActiveRedemptions: settings.preventMultipleActiveRedemptions,
    },
    webhooks: {
      lastReceivedAt: lastEvent?.receivedAt ? lastEvent.receivedAt.toISOString() : null,
      failedLast24h,
      unprocessed,
    },
  });
}

function dollarsFromCents(cents: number): string {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "0.00";
  return (n / 100).toFixed(2);
}

export default function AppSupportPage() {
  const { shop, settings, webhooks } = useLoaderData<typeof loader>();

  const setupWarnings: string[] = [];
  if (!settings.eligibleCollectionHandle?.trim()) setupWarnings.push("Eligible collection handle is empty.");
  if (!settings.eligibleCollectionGid) setupWarnings.push("Eligible collection GID is not cached yet (save settings to resolve).");
  if (webhooks.failedLast24h > 0) setupWarnings.push(`Webhook failures in last 24h: ${webhooks.failedLast24h}.`);
  if (webhooks.unprocessed > 0) setupWarnings.push(`Unprocessed webhook events: ${webhooks.unprocessed}.`);

  return (
    <Page
      title="Support & Setup"
      backAction={{ content: "Back", url: "/app" }}
      subtitle="Self-serve setup checklist, diagnostics, and support contact"
    >
      <Layout>
        <Layout.Section>
          {setupWarnings.length ? (
            <Banner tone="warning" title="Setup attention required">
              <List type="bullet">
                {setupWarnings.map((w, i) => (
                  <List.Item key={i}>{w}</List.Item>
                ))}
              </List>
            </Banner>
          ) : (
            <Banner tone="success" title="Looks healthy">
              No obvious setup issues detected.
            </Banner>
          )}
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Store
                </Text>
                <Badge tone="info">{shop}</Badge>
              </InlineStack>

              <Text as="p" variant="bodyMd">
                For support, email{" "}
                <a href="mailto:Support@TwoMenOnAYellowCouch.com">Support@TwoMenOnAYellowCouch.com</a>.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Getting started
              </Text>
              <List type="number">
                <List.Item>
                  Configure the program in <Link to="/app/settings">Settings</Link> (earn rate, eligible collection handle,
                  redemption steps/value map, and exclusions).
                </List.Item>
                <List.Item>
                  Enable the Customer Account UI extension in your store’s customer accounts. Ensure the extension setting
                  <b> App Base URL</b> points to your current environment (dev tunnel or production domain).
                </List.Item>
                <List.Item>
                  Confirm webhooks are receiving and processing under <Link to="/app/webhooks">Webhooks</Link>.
                </List.Item>
                <List.Item>
                  Configure a daily scheduler to call <code>GET /jobs/expire</code> with your <code>JOB_TOKEN</code>.
                </List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Current configuration
              </Text>

              <List type="bullet">
                <List.Item>
                  Earn rate: <b>{settings.earnRate}</b> point(s) per $1 eligible spend
                </List.Item>
                <List.Item>
                  Minimum order to redeem: <b>${dollarsFromCents(settings.redemptionMinOrderCents)}</b>
                </List.Item>
                <List.Item>
                  Eligible collection handle: <b>{settings.eligibleCollectionHandle}</b>
                </List.Item>
                <List.Item>
                  Eligible collection GID cached: <b>{settings.eligibleCollectionGid ? "Yes" : "No"}</b>
                </List.Item>
                <List.Item>
                  Discount code expiry: <b>{settings.redemptionExpiryHours}</b> hour(s)
                </List.Item>
                <List.Item>
                  Inactivity expiry: <b>{settings.pointsExpireInactivityDays}</b> day(s)
                </List.Item>
                <List.Item>
                  Prevent multiple active redemptions: <b>{settings.preventMultipleActiveRedemptions ? "On" : "Off"}</b>
                </List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Webhook status
              </Text>
              <List type="bullet">
                <List.Item>
                  Last webhook received: <b>{webhooks.lastReceivedAt ? new Date(webhooks.lastReceivedAt).toLocaleString() : "(none)"}</b>
                </List.Item>
                <List.Item>
                  Failed in last 24h: <b>{webhooks.failedLast24h}</b>
                </List.Item>
                <List.Item>
                  Unprocessed queued: <b>{webhooks.unprocessed}</b>
                </List.Item>
              </List>
              <InlineStack gap="200">
                <a href="/support" style={{ textDecoration: "none" }}>
                  <Badge tone="info">Public support page</Badge>
                </a>
                <a href="/privacy" style={{ textDecoration: "none" }}>
                  <Badge tone="info">Privacy</Badge>
                </a>
                <a href="/terms" style={{ textDecoration: "none" }}>
                  <Badge tone="info">Terms</Badge>
                </a>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
