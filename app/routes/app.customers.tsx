import {
  Page,
  Layout,
  Card,
  Text,
  IndexTable,
  useIndexResourceState,
  Badge,
  Button,
  InlineStack,
  Modal,
  TextField,
  BlockStack,
} from "@shopify/polaris";
import crypto from "crypto";
import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, json, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { LedgerType } from "@prisma/client";

type CustomerRow = {
  id: string;
  customerId: string;
  balance: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  lastActivityAt: string;
  expiredAt: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const rows = await db.customerPointsBalance.findMany({
    where: { shop },
    orderBy: { lastActivityAt: "desc" },
    take: 100,
    select: {
      id: true,
      customerId: true,
      balance: true,
      lifetimeEarned: true,
      lifetimeRedeemed: true,
      lastActivityAt: true,
      expiredAt: true,
    },
  });

  return json({
    shop,
    customers: rows.map(
      (c): CustomerRow => ({
        id: c.id,
        customerId: c.customerId,
        balance: c.balance,
        lifetimeEarned: c.lifetimeEarned,
        lifetimeRedeemed: c.lifetimeRedeemed,
        lastActivityAt: c.lastActivityAt.toISOString(),
        expiredAt: c.expiredAt ? c.expiredAt.toISOString() : null,
      }),
    ),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent !== "adjust") {
    return json({ ok: false, error: "Unknown intent" }, { status: 400 });
  }

  const customerId = String(form.get("customerId") || "").trim();
  const deltaRaw = String(form.get("pointsDelta") || "").trim();

  const delta = Math.trunc(Number(deltaRaw));
  if (!customerId || !Number.isFinite(delta) || delta === 0) {
    return json({ ok: false, error: "Invalid customerId or pointsDelta" }, { status: 400 });
  }

  const now = new Date();
  const sourceId = `ADMIN_ADJUST:${crypto.randomUUID()}`;

  try {
    await db.$transaction(async (tx) => {
      await tx.pointsLedger.create({
        data: {
          shop,
          customerId,
          type: LedgerType.ADJUST,
          delta,
          source: "ADMIN",
          sourceId,
          description: `Admin adjustment: ${delta > 0 ? "+" : ""}${delta} point(s).`,
        },
      });

      // Upsert balance row. IMPORTANT: never null-out lastActivityAt.
      const existing = await tx.customerPointsBalance.findUnique({
        where: { shop_customerId: { shop, customerId } },
        select: { id: true, balance: true },
      });

      if (!existing) {
        await tx.customerPointsBalance.create({
          data: {
            shop,
            customerId,
            balance: Math.max(0, delta),
            lifetimeEarned: 0,
            lifetimeRedeemed: 0,
            lastActivityAt: now,
            expiredAt: null,
          },
        });
      } else {
        await tx.customerPointsBalance.update({
          where: { id: existing.id },
          data: {
            balance: Math.max(0, existing.balance + delta),
            lastActivityAt: now,
            expiredAt: null,
          },
        });
      }
    });

    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Adjustment failed" }, { status: 500 });
  }
};

export default function CustomersAdminRoute() {
  const { customers } = useLoaderData() as { customers: CustomerRow[] };
  const actionData = useActionData() as { ok?: boolean; error?: string } | undefined;
  const navigation = useNavigation();

  const resourceName = {
    singular: "customer",
    plural: "customers",
  };

  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(customers);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalCustomerId, setModalCustomerId] = useState<string>("");
  const [deltaValue, setDeltaValue] = useState<string>("");

  const isSubmitting = navigation.state === "submitting";

  const rowsMarkup = useMemo(() => {
    return customers.map((c, index) => {
      const expired = Boolean(c.expiredAt);
      return (
        <IndexTable.Row id={c.id} key={c.id} position={index} selected={selectedResources.includes(c.id)}>
          <IndexTable.Cell>
            <Text as="span" variant="bodyMd" fontWeight="bold">
              {c.customerId}
            </Text>
          </IndexTable.Cell>

          <IndexTable.Cell>
            <InlineStack gap="200" blockAlign="center">
              <Text as="span">{c.balance}</Text>
              {expired ? <Badge tone="warning">Expired</Badge> : <Badge tone="success">Active</Badge>}
            </InlineStack>
          </IndexTable.Cell>

          <IndexTable.Cell>{c.lifetimeEarned}</IndexTable.Cell>
          <IndexTable.Cell>{c.lifetimeRedeemed}</IndexTable.Cell>
          <IndexTable.Cell>{new Date(c.lastActivityAt).toLocaleString()}</IndexTable.Cell>

          <IndexTable.Cell>
            <Button
              size="slim"
              onClick={() => {
                setModalCustomerId(c.customerId);
                setDeltaValue("");
                setModalOpen(true);
              }}
            >
              Adjust
            </Button>
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    });
  }, [customers, selectedResources]);

  return (
    <Page title="Customers">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="p" variant="bodyMd">
                Admin-only view of loyalty balances. Adjustments update <strong>balance</strong> only (no change to
                lifetime earned/redeemed).
              </Text>
              {actionData?.error ? (
                <Text as="p" variant="bodyMd" tone="critical">
                  {actionData.error}
                </Text>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <IndexTable
              resourceName={resourceName}
              itemCount={customers.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "Customer ID" },
                { title: "Balance" },
                { title: "Lifetime Earned" },
                { title: "Lifetime Redeemed" },
                { title: "Last Activity" },
                { title: "Actions" },
              ]}
            >
              {rowsMarkup}
            </IndexTable>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={`Adjust points — Customer ${modalCustomerId}`}
        primaryAction={
          <Button
            variant="primary"
            loading={isSubmitting}
            disabled={isSubmitting || !deltaValue.trim()}
            onClick={() => {
              const form = document.getElementById("adjust-form") as HTMLFormElement | null;
              form?.requestSubmit();
            }}
          >
            Apply
          </Button>
        }
        secondaryActions={[{ content: "Cancel", onAction: () => setModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              Enter a positive or negative integer. Example: <code>50</code> adds 50 points; <code>-50</code> removes 50
              points (floor at 0).
            </Text>

            <Form method="post" id="adjust-form" onSubmit={() => setModalOpen(false)}>
              <input type="hidden" name="intent" value="adjust" />
              <input type="hidden" name="customerId" value={modalCustomerId} />

              <TextField
                label="Points delta"
                name="pointsDelta"
                value={deltaValue}
                onChange={setDeltaValue}
                autoComplete="off"
                helpText="Use whole numbers only"
              />
            </Form>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
