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
} from "@shopify/polaris";
import type { LoaderFunctionArgs } from "react-router";
import type { ActionFunctionArgs } from "react-router";
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

  return { events, filters: { outcome, topic, resourceId } };
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
  const { events, filters } = useLoaderData<typeof loader>();
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

  const runSearch = () => {
    const fd = new FormData();
    fd.set("outcome", outcome);
    fd.set("topic", topic);
    fd.set("resourceId", resourceId);
    submit(fd, { method: "get" });
  };

  return (
    <Page title="Webhook Processing Log">
      <Card sectioned>
        <InlineStack gap="400" align="start" blockAlign="center">
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

          <TextField label="Topic contains" value={topic} onChange={(v) => setTopic(v)} autoComplete="off" />
          <TextField label="Resource ID" value={resourceId} onChange={(v) => setResourceId(v)} autoComplete="off" />

          <Button onClick={runSearch}>Search</Button>

          <Form method="post">
            <input type="hidden" name="intent" value="register" />
            <Button submit>Re-register webhooks</Button>
          </Form>
        </InlineStack>

        {actionData?.ok === true ? <Banner tone="success">{actionData.message}</Banner> : null}
        {actionData?.ok === false ? <Banner tone="critical">{actionData.error}</Banner> : null}

        <Text as="p" tone="subdued">
          Latest webhook events received and how they were handled.
        </Text>
      </Card>

      <Card>
        <DataTable
          columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
          headings={["Webhook ID", "Topic", "Resource", "Received", "Processed", "Outcome", "Message"]}
          rows={rows}
        />
      </Card>
    </Page>
  );
}
