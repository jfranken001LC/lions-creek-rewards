import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data, Form, useLoaderData, useNavigation } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  IndexTable,
  Badge,
  Tooltip,
  Modal,
} from "@shopify/polaris";
import { useEffect, useMemo, useState } from "react";
import { prisma } from "../lib/prisma.server";
import { requireAdmin } from "../lib/shopify.server";
import { formatIsoDateTimeLocal } from "../lib/time";

type CustomerRow = {
  id: string;
  shop: string;
  customerId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  pointsBalance: number;
  lifetimePointsEarned: number;
  lifetimePointsRedeemed: number;
  createdAt: string;
  updatedAt: string;
};

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";

  const where =
    q.length > 0
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" as const } },
            { firstName: { contains: q, mode: "insensitive" as const } },
            { lastName: { contains: q, mode: "insensitive" as const } },
            { customerId: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {};

  const customers = await prisma.customer.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: 250,
  });

  const rows: CustomerRow[] = customers.map((c) => ({
    id: c.id,
    shop: c.shop,
    customerId: c.customerId,
    email: c.email,
    firstName: c.firstName,
    lastName: c.lastName,
    pointsBalance: c.pointsBalance,
    lifetimePointsEarned: c.lifetimePointsEarned,
    lifetimePointsRedeemed: c.lifetimePointsRedeemed,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }));

  return data({ q, rows });
}

export async function action({ request }: ActionFunctionArgs) {
  await requireAdmin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "adjust_points") {
    const id = String(formData.get("id") || "");
    const delta = Number(formData.get("delta") || 0);
    const reason = String(formData.get("reason") || "").trim();

    if (!id || !Number.isFinite(delta) || delta === 0) {
      return data({ ok: false, error: "Invalid request" }, { status: 400 });
    }

    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) {
      return data({ ok: false, error: "Customer not found" }, { status: 404 });
    }

    // Adjust points
    const updated = await prisma.customer.update({
      where: { id },
      data: {
        pointsBalance: customer.pointsBalance + delta,
        lifetimePointsEarned:
          delta > 0 ? customer.lifetimePointsEarned + delta : undefined,
        lifetimePointsRedeemed:
          delta < 0 ? customer.lifetimePointsRedeemed + Math.abs(delta) : undefined,
      },
    });

    // Audit
    await prisma.pointsEvent.create({
      data: {
        shop: updated.shop,
        customerId: updated.customerId,
        type: delta > 0 ? "MANUAL_AWARD" : "MANUAL_DEDUCT",
        points: Math.abs(delta),
        source: "ADMIN",
        reason: reason || null,
        createdAt: new Date(),
      },
    });

    return data({ ok: true });
  }

  return data({ ok: false, error: "Unsupported intent" }, { status: 400 });
}

export default function CustomersPage() {
  const { q, rows } = useLoaderData<typeof loader>();
  const navigation = useNavigation();

  const [query, setQuery] = useState(q);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerRow | null>(
    null,
  );
  const [delta, setDelta] = useState("0");
  const [reason, setReason] = useState("");

  useEffect(() => {
    setQuery(q);
  }, [q]);

  const isSubmitting = navigation.state !== "idle";

  const resourceName = useMemo(
    () => ({ singular: "customer", plural: "customers" }),
    [],
  );

  const rowMarkup = rows.map((r, index) => {
    const name = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || "(no name)";
    const pointsBadge =
      r.pointsBalance >= 0 ? (
        <Badge tone="success">{r.pointsBalance}</Badge>
      ) : (
        <Badge tone="critical">{r.pointsBalance}</Badge>
      );

    return (
      <IndexTable.Row id={r.id} key={r.id} position={index}>
        <IndexTable.Cell>
          <BlockStack gap="050">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {name}
            </Text>
            <Text as="span" tone="subdued" variant="bodySm">
              {r.email ?? "(no email)"}
            </Text>
          </BlockStack>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text as="span" variant="bodySm">
            {r.customerId}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>{pointsBadge}</IndexTable.Cell>

        <IndexTable.Cell>
          <Tooltip content={`Earned: ${r.lifetimePointsEarned} • Redeemed: ${r.lifetimePointsRedeemed}`}>
            <Text as="span" variant="bodySm">
              {r.lifetimePointsEarned} / {r.lifetimePointsRedeemed}
            </Text>
          </Tooltip>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text as="span" variant="bodySm">
            {formatIsoDateTimeLocal(r.updatedAt)}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Button
            size="slim"
            onClick={() => {
              setSelectedCustomer(r);
              setDelta("0");
              setReason("");
              setModalOpen(true);
            }}
          >
            Adjust points
          </Button>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page title="Customers">
      <BlockStack gap="400">
        <Card>
          <Form method="get">
            <InlineStack gap="200" align="start" blockAlign="center">
              <div style={{ minWidth: 340 }}>
                <TextField
                  label="Search"
                  labelHidden
                  value={query}
                  onChange={setQuery}
                  placeholder="Email, name, or customer ID…"
                  autoComplete="off"
                  name="q"
                />
              </div>
              <Button submit disabled={isSubmitting}>
                Search
              </Button>
              <Button
                onClick={() => {
                  setQuery("");
                  // Navigate by submitting empty
                  const f = document.createElement("form");
                  f.method = "get";
                  f.action = window.location.pathname;
                  document.body.appendChild(f);
                  f.submit();
                }}
              >
                Clear
              </Button>
            </InlineStack>
          </Form>
        </Card>

        <Card padding="0">
          <IndexTable
            resourceName={resourceName}
            itemCount={rows.length}
            selectable={false}
            headings={[
              { title: "Customer" },
              { title: "Customer ID" },
              { title: "Points" },
              { title: "Lifetime (E/R)" },
              { title: "Updated" },
              { title: "" },
            ]}
          >
            {rowMarkup}
          </IndexTable>
        </Card>

        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Adjust points"
          primaryAction={{
            content: "Apply",
            onAction: () => {
              if (!selectedCustomer) return;

              const form = document.createElement("form");
              form.method = "post";
              form.style.display = "none";

              const fields: Array<[string, string]> = [
                ["intent", "adjust_points"],
                ["id", selectedCustomer.id],
                ["delta", delta],
                ["reason", reason],
              ];

              for (const [k, v] of fields) {
                const input = document.createElement("input");
                input.type = "hidden";
                input.name = k;
                input.value = v;
                form.appendChild(input);
              }

              document.body.appendChild(form);
              form.submit();
            },
            disabled:
              !selectedCustomer ||
              !Number.isFinite(Number(delta)) ||
              Number(delta) === 0 ||
              isSubmitting,
          }}
          secondaryActions={[
            {
              content: "Cancel",
              onAction: () => setModalOpen(false),
            },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Enter a positive number to award points, negative to deduct.
              </Text>
              <TextField
                label="Delta"
                value={delta}
                onChange={setDelta}
                autoComplete="off"
              />
              <TextField
                label="Reason (optional)"
                value={reason}
                onChange={setReason}
                autoComplete="off"
              />
            </BlockStack>
          </Modal.Section>
        </Modal>
      </BlockStack>
    </Page>
  );
}
