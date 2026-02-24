import {
  Page,
  Card,
  DataTable,
  Text,
  Badge,
  InlineStack,
  Select,
  TextField,
  Button,
  Banner,
  BlockStack,
} from "@shopify/polaris";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, useActionData, useLoaderData, useSubmit } from "react-router";
import { useMemo, useState } from "react";
import { authenticate, registerWebhooks } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const outcome = url.searchParams.get("outcome") || "ALL";
  const topic = url.searchParams.get("topic") || "";
  const resourceId = url.searchParams.get("resourceId") || "";

  const where: any = { shop };
  if (outcome !== "ALL") where.outcome = outcome;
  if (topic) where.topic = { contains: topic };
  if (resourceId) where.resourceId = resourceId;

  const events = await db.webhookEvent.findMany({
    where,
    orderBy: { receivedAt: "desc" },
    take: 250,
    select: {
      webhookId: true,
      topic: true,
      resourceId: true,
      receivedAt: true,
      processedAt: true,
      outcome: true,
      outcomeMessage: true,
    },
  });

  // Errors are filtered by shop + (optional) topic/resource. Outcome doesn't apply.
  const errorWhere: any = { shop };
  if (topic) errorWhere.topic = { contains: topic };
  if (resourceId) errorWhere.resourceId = resourceId;

  const errors = await db.webhookError.findMany({
    where: errorWhere,
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      topic: true,
      webhookId: true,
      resourceId: true,
      createdAt: true,
      errorMessage: true,
    },
  });

  return data({ events, errors, filters: { outcome, topic, resourceId } });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent !== "register") {
    return data({ ok: false, error: "Unknown action" }, { status: 400 });
  }

  try {
    await registerWebhooks({ session });
    return data({ ok: true, message: "Webhook subscriptions re-registered." });
  } catch (e: any) {
    return data({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
};

export default function WebhooksLogPage() {
  const { events, errors, filters } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();

  const [topic, setTopic] = useState(filters.topic);
  const [resourceId, setResourceId] = useState(filters.resourceId);
  const [outcome, setOutcome] = useState(filters.outcome);

  const rows = useMemo(
    () =>
      events.map((e) => [
        e.webhookId,
        e.topic,
        e.resourceId || "—",
        new Date(e.receivedAt).toLocaleString(),
        e.processedAt ? new Date(e.processedAt).toLocaleString() : "—",
        <Badge
          key={`${e.webhookId}-badge`}
          tone={
            e.outcome === "PROCESSED"
              ? "success"
              : e.outcome === "FAILED"
              ? "critical"
              : e.outcome === "SKIPPED"
              ? "warning"
              : "info"
          }
        >
          {e.outcome}
        </Badge>,
        e.outcomeMessage || "—",
      ]),
    [events],
  );

  const errorRows = useMemo(
    () =>
      errors.map((e) => [
        new Date(e.createdAt).toLocaleString(),
        e.topic,
        e.webhookId || "—",
        e.resourceId || "—",
        e.errorMessage,
      ]),
    [errors],
  );

  const runSearch = () => {
    const fd = new FormData();
    fd.set("outcome", outcome);
    fd.set("topic", topic);
    fd.set("resourceId", resourceId);
    submit(fd, { method: "get" });
  };

  return (
    <Page title="Webhook Processing Log">
      <BlockStack gap="400">
        <Card padding="400">
          <InlineStack gap="400" align="start" blockAlign="center" wrap>
            <Select
              label="Outcome"
              options={[
                { label: "All", value: "ALL" },
                { label: "Received", value: "RECEIVED" },
                { label: "Processed", value: "PROCESSED" },
                { label: "Skipped", value: "SKIPPED" },
                { label: "Failed", value: "FAILED" },
              ]}
              value={outcome}
              onChange={(value) => setOutcome(value)}
            />

            <TextField
              label="Topic contains"
              value={topic}
              onChange={(v) => setTopic(v)}
              autoComplete="off"
            />

            <TextField
              label="Resource ID"
              value={resourceId}
              onChange={(v) => setResourceId(v)}
              autoComplete="off"
            />

            <Button onClick={runSearch}>Search</Button>

            <Form method="post">
              <input type="hidden" name="intent" value="register" />
              <Button submit>Re-register webhooks</Button>
            </Form>
          </InlineStack>
        </Card>

        {actionData?.ok === true ? (
          <Card padding="400">
            <Banner tone="success">{actionData.message}</Banner>
          </Card>
        ) : null}

        {actionData?.ok === false ? (
          <Card padding="400">
            <Banner tone="critical">{actionData.error}</Banner>
          </Card>
        ) : null}

        <Card padding="400">
          <Text as="p" tone="subdued">
            Latest webhook events received and how they were handled.
          </Text>
        </Card>

        <Card padding="400">
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
            headings={["Webhook ID", "Topic", "Resource", "Received", "Processed", "Outcome", "Message"]}
            rows={rows}
          />
        </Card>

        <Card padding="400">
          <Text as="h2" variant="headingMd">
            Webhook Errors (latest)
          </Text>
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text"]}
            headings={["When", "Topic", "Webhook ID", "Resource", "Error"]}
            rows={errorRows}
          />
        </Card>
      </BlockStack>
    </Page>
  );
}
