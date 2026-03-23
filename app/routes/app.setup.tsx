import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  FormLayout,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import React from "react";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getOrCreateShopSettings, upsertShopSettings } from "../lib/shopSettings.server";
import { runHistoricalOrderBackfill } from "../lib/historicalBackfill.server";

type LoaderData = {
  shop: string;
  historicalBackfillEnabled: boolean;
  historicalBackfillStartDate: string;
  historicalBackfillLastRunAt: string | null;
  historicalBackfillLastStatus: string | null;
  historicalBackfillLastSummary: Record<string, any> | null;
  latestRun: any | null;
  requiresReadAllOrders: boolean;
};

type ActionData =
  | { ok: true; message: string; summary?: Record<string, any> | null }
  | { ok: false; error: string; summary?: Record<string, any> | null };

function dateInputValue(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function parseBoolean(form: FormData, key: string): boolean {
  return String(form.get(key) ?? "") === "on";
}

function normalizeStartDate(raw: FormDataEntryValue | null, fallback: string): string {
  const trimmed = String(raw ?? "").trim();
  return trimmed || fallback;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await getOrCreateShopSettings(shop);
  const latestRun = await (db as any).historicalBackfillRun?.findFirst?.({ where: { shop }, orderBy: { createdAt: "desc" } }) ?? null;

  const startDateValue = settings.historicalBackfillStartDate ?? "";
  const requiresReadAllOrders = (() => {
    if (!startDateValue) return false;
    const startDate = new Date(startDateValue);
    const threshold = new Date();
    threshold.setUTCDate(threshold.getUTCDate() - 60);
    return startDate < threshold;
  })();

  return data<LoaderData>({
    shop,
    historicalBackfillEnabled: settings.historicalBackfillEnabled,
    historicalBackfillStartDate: dateInputValue(settings.historicalBackfillStartDate),
    historicalBackfillLastRunAt: settings.historicalBackfillLastRunAt,
    historicalBackfillLastStatus: settings.historicalBackfillLastStatus,
    historicalBackfillLastSummary: settings.historicalBackfillLastSummary,
    latestRun,
    requiresReadAllOrders,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const existing = await getOrCreateShopSettings(shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");

  const historicalBackfillEnabled = parseBoolean(form, "historicalBackfillEnabled");
  const historicalBackfillStartDate = normalizeStartDate(form.get("historicalBackfillStartDate"), dateInputValue(existing.historicalBackfillStartDate));

  if (!historicalBackfillStartDate) {
    return data<ActionData>({ ok: false, error: "A historical backfill start date is required." }, { status: 400 });
  }

  try {
    if (intent === "save") {
      await upsertShopSettings(shop, {
        historicalBackfillEnabled,
        historicalBackfillStartDate: new Date(`${historicalBackfillStartDate}T00:00:00.000Z`).toISOString(),
      } as any);

      return data<ActionData>({ ok: true, message: "Setup saved." });
    }

    if (intent === "run") {
      await upsertShopSettings(shop, {
        historicalBackfillEnabled,
        historicalBackfillStartDate: new Date(`${historicalBackfillStartDate}T00:00:00.000Z`).toISOString(),
      } as any);

      const summary = await runHistoricalOrderBackfill({
        shop,
        startDate: historicalBackfillStartDate,
        requestedBy: String((session as any)?.email ?? (session as any)?.userId ?? "admin"),
        persistConfiguration: historicalBackfillEnabled,
        adminGraphql: async (query, variables) => {
          const response = await admin.graphql(query, { variables: variables ?? {} });
          const json = await response.json().catch(() => null);
          if (!response.ok) {
            const details = json ? ` ${JSON.stringify(json)}` : "";
            throw new Error(`Shopify GraphQL failed: ${response.status} ${response.statusText}${details}`);
          }
          if (json?.errors?.length) {
            throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
          }
          return json?.data ?? null;
        },
      });

      return data<ActionData>({
        ok: true,
        message: `Historical backfill completed. Scanned ${summary.ordersScanned} order(s) and awarded ${summary.pointsAwarded} point(s).`,
        summary,
      });
    }

    return data<ActionData>({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    if (error instanceof Response) throw error;

    return data<ActionData>(
      { ok: false, error: String(error?.message ?? error ?? "Historical backfill failed.") },
      { status: 400 },
    );
  }
};

export default function SetupPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();

  const [historicalBackfillEnabled, setHistoricalBackfillEnabled] = React.useState(loaderData.historicalBackfillEnabled);
  const [historicalBackfillStartDate, setHistoricalBackfillStartDate] = React.useState(loaderData.historicalBackfillStartDate);

  const lastSummary = actionData?.summary ?? loaderData.historicalBackfillLastSummary ?? null;

  return (
    <Page
      title="Setup & Historical Backfill"
      subtitle={`Shop: ${loaderData.shop}`}
      backAction={{ content: "Back", url: "/app" }}
      primaryAction={{
        content: "Save setup",
        onAction: () => {
          const form = document.getElementById("historical-backfill-form") as HTMLFormElement | null;
          if (!form) return;
          const intent = form.querySelector('input[name="intent"]') as HTMLInputElement | null;
          if (intent) intent.value = "save";
          form.requestSubmit();
        },
      }}
    >
      <Layout>
        <Layout.Section>
          {actionData ? (
            <Banner tone={actionData.ok ? "success" : "critical"} title={actionData.ok ? "Completed" : "Could not complete request"}>
              {actionData.ok ? actionData.message : actionData.error}
            </Banner>
          ) : null}

          {loaderData.requiresReadAllOrders ? (
            <Banner tone="warning" title="Older than 60 days may require read_all_orders">
              Historical backfill from this start date may require the app to be granted the <code>read_all_orders</code> scope in addition to <code>read_orders</code>. After scope changes, reinstall or re-authorize the app before running the backfill.
            </Banner>
          ) : null}
        </Layout.Section>

        <Layout.Section>
          <Form id="historical-backfill-form" method="post">
            <input type="hidden" name="intent" value="save" />
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Optional installation configuration</Text>
                <Text as="p" tone="subdued">
                  v1.12 adds an optional setup path that lets the merchant choose a historical start date and then retroactively work forward through paid order history to calculate points balances and tier standing through today.
                </Text>

                <FormLayout>
                  <Checkbox
                    label="Enable historical backfill for this shop"
                    name="historicalBackfillEnabled"
                    checked={historicalBackfillEnabled}
                    onChange={(checked) => setHistoricalBackfillEnabled(checked)}
                    helpText="This stores the installation backfill preference in shop settings. Running the backfill remains a deliberate admin action."
                  />

                  <TextField
                    label="Historical start date"
                    type="date"
                    name="historicalBackfillStartDate"
                    value={historicalBackfillStartDate}
                    onChange={setHistoricalBackfillStartDate}
                    autoComplete="off"
                    helpText="Orders from this date through the current date are scanned in chronological order. Existing snapshots and refund/cancel reversal ledgers remain idempotent."
                  />
                </FormLayout>

                <InlineStack gap="300">
                  <Button
                    submit
                    onClick={() => {
                      const intent = document.querySelector('#historical-backfill-form input[name="intent"]') as HTMLInputElement | null;
                      if (intent) intent.value = "save";
                    }}
                  >
                    Save setup
                  </Button>
                  <Button
                    variant="primary"
                    submit
                    onClick={() => {
                      const intent = document.querySelector('#historical-backfill-form input[name="intent"]') as HTMLInputElement | null;
                      if (intent) intent.value = "run";
                    }}
                  >
                    Run historical backfill now
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Form>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">What the backfill does</Text>
              <List type="bullet">
                <List.Item>Loads orders from the chosen start date through today using the shop’s offline Admin API session.</List.Item>
                <List.Item>Applies the current eligibility filters, base earn rate, redemption configuration, and tier definitions.</List.Item>
                <List.Item>Creates historical order snapshots and earn ledger rows only when they do not already exist.</List.Item>
                <List.Item>Processes historical refunds and cancellations idempotently so current balances and tier progression reflect the net order history.</List.Item>
                <List.Item>Recomputes customer tier snapshots as historical events are applied in chronological order.</List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Latest historical backfill status</Text>
                <InlineStack gap="200">
                  <Text as="p" tone="subdued">{loaderData.historicalBackfillLastRunAt ? new Date(loaderData.historicalBackfillLastRunAt).toLocaleString() : "(none yet)"}</Text>
                </InlineStack>
              </InlineStack>

              <InlineStack gap="200">
                <Text as="p">Status:</Text>
                <Text as="p" variant="headingSm">{loaderData.historicalBackfillLastStatus ?? "Not run yet"}</Text>
              </InlineStack>

              {lastSummary ? (
                <BlockStack gap="200">
                  <InlineStack align="space-between"><Text as="p">Orders scanned</Text><Text as="p" variant="headingMd">{Number(lastSummary.ordersScanned ?? 0)}</Text></InlineStack>
                  <InlineStack align="space-between"><Text as="p">Orders awarded</Text><Text as="p" variant="headingMd">{Number(lastSummary.awardedOrders ?? 0)}</Text></InlineStack>
                  <InlineStack align="space-between"><Text as="p">Points awarded</Text><Text as="p" variant="headingMd">{Number(lastSummary.pointsAwarded ?? 0)}</Text></InlineStack>
                  <InlineStack align="space-between"><Text as="p">Refund reversals processed</Text><Text as="p" variant="headingMd">{Number(lastSummary.refundsProcessed ?? 0)}</Text></InlineStack>
                  <InlineStack align="space-between"><Text as="p">Cancellation reversals processed</Text><Text as="p" variant="headingMd">{Number(lastSummary.cancellationsProcessed ?? 0)}</Text></InlineStack>
                  {lastSummary.lastError ? <Text as="p" tone="critical">Last error: {String(lastSummary.lastError)}</Text> : null}
                </BlockStack>
              ) : (
                <Text as="p" tone="subdued">No historical backfill run has been recorded for this shop yet.</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
