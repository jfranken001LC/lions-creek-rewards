// app/routes/app.webhooks.tsx
// Drop-in replacement (small congruency update: wording + expects payloadJson exists)

import type { LoaderFunctionArgs } from "react-router";
import { data, Form, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Select, DataTable, Badge } from "@shopify/polaris";

type LoaderData = {
  events: Array<{
    id: string;
    receivedAt: string;
    topic: string;
    resourceId: string;
    outcome: string;
    outcomeMessage: string | null;
  }>;
  filters: {
    outcome: string;
    topic: string;
  };
  topicOptions: Array<{ label: string; value: string }>;
};

function formatIso(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function outcomeBadge(outcome: string) {
  switch (outcome) {
    case "PROCESSED":
      return <Badge tone="success">PROCESSED</Badge>;
    case "FAILED":
      return <Badge tone="critical">FAILED</Badge>;
    case "IGNORED":
      return <Badge tone="warning">IGNORED</Badge>;
    default:
      return <Badge>RECEIVED</Badge>;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const outcome = url.searchParams.get("outcome") ?? "ALL";
  const topic = url.searchParams.get("topic") ?? "ALL";

  const where: any = {};
  if (outcome !== "ALL") where.outcome = outcome;
  if (topic !== "ALL") where.topic = topic;

  const events = await db.webhookEvent.findMany({
    where,
    orderBy: { receivedAt: "desc" },
    take: 200,
    select: {
      id: true,
      receivedAt: true,
      topic: true,
      resourceId: true,
      outcome: true,
      outcomeMessage: true,
    },
  });

  const distinctTopics = await db.webhookEvent
    .findMany({
      distinct: ["topic"],
      select: { topic: true },
      orderBy: { topic: "asc" },
    })
    .catch(() => []);

  const topicOptions = [
    { label: "All topics", value: "ALL" },
    ...distinctTopics.map((t) => ({ label: t.topic, value: t.topic })),
  ];

  return data<LoaderData>({
    events: events.map((e) => ({
      id: e.id,
      receivedAt: e.receivedAt.toISOString(),
      topic: e.topic,
      resourceId: e.resourceId,
      outcome: String(e.outcome),
      outcomeMessage: e.outcomeMessage,
    })),
    filters: { outcome, topic },
    topicOptions,
  });
};

export default function WebhooksLogPage() {
  const { events, filters, topicOptions } = useLoaderData() as LoaderData;

  const outcomeOptions = [
    { label: "All outcomes", value: "ALL" },
    { label: "RECEIVED", value: "RECEIVED" },
    { label: "PROCESSED", value: "PROCESSED" },
    { label: "IGNORED", value: "IGNORED" },
    { label: "FAILED", value: "FAILED" },
  ];

  const rows = events.map((e) => [
    formatIso(e.receivedAt),
    e.topic,
    e.resourceId,
    outcomeBadge(e.outcome),
    e.outcomeMessage ?? "",
  ]);

  return (
    <Page title="Webhooks">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="p" tone="subdued">
                Webhooks are app-managed via <Text as="span">shopify.app.toml</Text> and delivered to <Text as="span">/webhooks</Text>. Payloads are stored (truncated) in the database for auditing.
              </Text>

              <Form method="get">
                <InlineStack gap="300" align="start">
                  <Select label="Outcome" name="outcome" options={outcomeOptions} value={filters.outcome} onChange={() => {}} />
                  <Select label="Topic" name="topic" options={topicOptions} value={filters.topic} onChange={() => {}} />
                  <div style={{ paddingTop: 22 }}>
                    <button type="submit" className="Polaris-Button Polaris-Button--primary">
                      <span className="Polaris-Button__Content">
                        <span className="Polaris-Button__Text">Filter</span>
                      </span>
                    </button>
                  </div>
                </InlineStack>
              </Form>

              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["Received", "Topic", "Resource", "Outcome", "Message"]}
                rows={rows}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
