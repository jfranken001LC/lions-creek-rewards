import React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import {
  Page, Layout, Card, TextField, IndexTable, Text, Button,
  InlineStack, BlockStack, Modal, FormLayout, Banner,
} from "@shopify/polaris";
import db from "../db.server";
import { requireAdmin } from "../lib/shopify.server";
import { LedgerType } from "@prisma/client";

type LoaderRow = {
  customerId: string;
  balance: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  lastActivityAt: string;
  expiredAt: string | null;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireAdmin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  const rows = await db.customerPointsBalance.findMany({
    where: { shop, ...(q ? { customerId: { contains: q } } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 250,
    select: { customerId: true, balance: true, lifetimeEarned: true, lifetimeRedeemed: true, lastActivityAt: true, expiredAt: true },
  });

  const dataRows: LoaderRow[] = rows.map((r) => ({
    customerId: r.customerId,
    balance: r.balance,
    lifetimeEarned: r.lifetimeEarned,
    lifetimeRedeemed: r.lifetimeRedeemed,
    lastActivityAt: r.lastActivityAt.toISOString(),
    expiredAt: r.expiredAt ? r.expiredAt.toISOString() : null,
  }));

  return data({ q, rows: dataRows });
}

export async function action({ request }: ActionFunctionArgs) {
  const session = await requireAdmin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "adjustPoints") return data({ ok: false, error: "Unknown action" }, { status: 400 });

  const customerId = String(form.get("customerId") ?? "").trim();
  const delta = Number(form.get("delta"));
  const reason = String(form.get("reason") ?? "").trim();

  if (!customerId) return data({ ok: false, error: "customerId is required" }, { status: 400 });
  if (!Number.isFinite(delta) || !Number.isInteger(delta) || delta === 0) return data({ ok: false, error: "delta must be a non-zero integer" }, { status: 400 });
  if (!reason) return data({ ok: false, error: "reason is required" }, { status: 400 });

  const now = new Date();

  try {
    const updated = await db.$transaction(async (tx) => {
      const bal = await tx.customerPointsBalance.findUnique({ where: { shop_customerId: { shop, customerId } } });
      const nextBalance = (bal?.balance ?? 0) + delta;
      if (nextBalance < 0) throw new Error("Adjustment would make balance negative");

      const next = await tx.customerPointsBalance.upsert({
        where: { shop_customerId: { shop, customerId } },
        create: { shop, customerId, balance: nextBalance, lifetimeEarned: 0, lifetimeRedeemed: 0, lastActivityAt: now, expiredAt: null },
        update: { balance: nextBalance, lastActivityAt: now, expiredAt: delta > 0 ? null : undefined },
      });

      await tx.pointsLedger.create({
        data: { shop, customerId, type: LedgerType.ADJUST, delta, source: "ADMIN_ADJUST", description: reason },
      });

      return next;
    });

    return data({ ok: true, customerId: updated.customerId, balance: updated.balance });
  } catch (err: any) {
    return data({ ok: false, error: err?.message ?? "Failed to adjust" }, { status: 400 });
  }
}

export default function CustomersPage() {
  const { rows, q } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const nav = useNavigation();

  const [search, setSearch] = React.useState(q ?? "");
  const [modalOpen, setModalOpen] = React.useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = React.useState("");
  const [delta, setDelta] = React.useState("");
  const [reason, setReason] = React.useState("");

  const busy = nav.state !== "idle";

  const runSearch = () => {
    const url = new URL(window.location.href);
    if (search.trim()) url.searchParams.set("q", search.trim());
    else url.searchParams.delete("q");
    window.location.assign(url.toString());
  };

  const openAdjust = (customerId: string) => {
    setSelectedCustomerId(customerId);
    setDelta("");
    setReason("");
    setModalOpen(true);
  };

  const submitAdjust = () => {
    const fd = new FormData();
    fd.set("intent", "adjustPoints");
    fd.set("customerId", selectedCustomerId);
    fd.set("delta", String(Number(delta)));
    fd.set("reason", reason);
    submit(fd, { method: "post" });
  };

  return (
    <Page title="Customers">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {actionData?.ok === false && actionData?.error ? <Banner tone="critical">{String(actionData.error)}</Banner> : null}
              {actionData?.ok === true ? <Banner tone="success">Saved.</Banner> : null}

              <InlineStack gap="200" align="start">
                <div style={{ flex: 1 }}>
                  <TextField label="Search by customer ID" labelHidden value={search} onChange={setSearch} placeholder="e.g., 123456789" autoComplete="off" />
                </div>
                <Button onClick={runSearch} disabled={busy}>Search</Button>
              </InlineStack>

              <IndexTable
                resourceName={{ singular: "customer", plural: "customers" }}
                itemCount={rows.length}
                selectable={false}
                headings={[
                  { title: "Customer ID" },
                  { title: "Balance" },
                  { title: "Lifetime earned" },
                  { title: "Lifetime redeemed" },
                  { title: "Last activity" },
                  { title: "Expired" },
                  { title: "" },
                ]}
              >
                {rows.map((r, idx) => (
                  <IndexTable.Row id={r.customerId} key={r.customerId} position={idx}>
                    <IndexTable.Cell><Text as="span" variant="bodyMd">{r.customerId}</Text></IndexTable.Cell>
                    <IndexTable.Cell>{r.balance}</IndexTable.Cell>
                    <IndexTable.Cell>{r.lifetimeEarned}</IndexTable.Cell>
                    <IndexTable.Cell>{r.lifetimeRedeemed}</IndexTable.Cell>
                    <IndexTable.Cell>{new Date(r.lastActivityAt).toLocaleString()}</IndexTable.Cell>
                    <IndexTable.Cell>{r.expiredAt ? new Date(r.expiredAt).toLocaleDateString() : ""}</IndexTable.Cell>
                    <IndexTable.Cell><Button size="micro" onClick={() => openAdjust(r.customerId)}>Adjust</Button></IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={`Adjust points — ${selectedCustomerId}`}
        primaryAction={{
          content: "Save",
          onAction: submitAdjust,
          loading: busy,
          disabled: !selectedCustomerId || !delta || !reason,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setModalOpen(false), disabled: busy }]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField label="Delta (positive or negative integer)" value={delta} onChange={setDelta} placeholder="e.g., 250 or -100" autoComplete="off" />
            <TextField label="Reason" value={reason} onChange={setReason} placeholder="e.g., goodwill adjustment" autoComplete="off" />
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
