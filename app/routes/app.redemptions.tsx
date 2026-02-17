import type { LoaderFunctionArgs } from "react-router";
import { json, useLoaderData, useSearchParams } from "react-router";
import {
  Badge,
  Button,
  ButtonGroup,
  Card,
  IndexTable,
  InlineStack,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";

import db from "../db.server";
import { authenticate } from "../shopify.server";

type RedemptionRow = {
  id: string;
  code: string;
  customerId: string;
  pointsUsed: number;
  valueCents: number;
  status: string;
  issuedAt: string;
  expiresAt: string;
  appliedAt: string | null;
  consumedAt: string | null;
  consumedOrderId: string | null;
};

function statusTone(status: string) {
  switch (status) {
    case "CONSUMED":
      return "success" as const;
    case "EXPIRED":
    case "CANCELLED":
    case "VOID":
      return "critical" as const;
    case "APPLIED":
      return "attention" as const;
    default:
      return "info" as const; // ISSUED
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const status = (url.searchParams.get("status") || "active").toLowerCase();
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(parseInt(url.searchParams.get("page") || "1", 10), 1);
  const pageSize = 100;
  const skip = (page - 1) * pageSize;
  const now = new Date();

  const where: any = { shop };

  if (q) {
    where.OR = [
      { code: { contains: q, mode: "insensitive" } },
      { customerId: { contains: q, mode: "insensitive" } },
      { consumedOrderId: { contains: q, mode: "insensitive" } },
    ];
  }

  if (status === "active") {
    where.status = { in: ["ISSUED", "APPLIED"] };
    where.expiresAt = { gt: now };
  } else if (status === "expired") {
    where.OR = [
      { status: { in: ["EXPIRED", "CANCELLED"] } },
      { status: { in: ["ISSUED", "APPLIED"] }, expiresAt: { lte: now } },
    ];
  } else if (status === "consumed") {
    where.status = "CONSUMED";
  } else if (status === "void") {
    where.status = "VOID";
  } else if (status !== "all") {
    // unknown filter -> treat as active
    where.status = { in: ["ISSUED", "APPLIED"] };
    where.expiresAt = { gt: now };
  }

  const [total, rows] = await Promise.all([
    db.redemption.count({ where }),
    db.redemption.findMany({
      where,
      orderBy: { issuedAt: "desc" },
      skip,
      take: pageSize,
      select: {
        id: true,
        code: true,
        customerId: true,
        pointsUsed: true,
        valueCents: true,
        status: true,
        issuedAt: true,
        expiresAt: true,
        appliedAt: true,
        consumedAt: true,
        consumedOrderId: true,
      },
    }),
  ]);

  const data: RedemptionRow[] = rows.map((r) => ({
    ...r,
    issuedAt: r.issuedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null,
    consumedAt: r.consumedAt ? r.consumedAt.toISOString() : null,
  }));

  return json({
    shop,
    status,
    q,
    page,
    pageSize,
    total,
    rows: data,
  });
}

export default function RedemptionsPage() {
  const { status, q, page, pageSize, total, rows } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page"); // reset pagination on filter changes
    setSearchParams(next);
  };

  const setPage = (nextPage: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(nextPage));
    setSearchParams(next);
  };

  const canPrev = page > 1;
  const canNext = page * pageSize < total;

  return (
    <Page title="Redemptions">
      <Card>
        <InlineStack gap="400" align="space-between">
          <TextField
            label="Search"
            labelHidden
            placeholder="Code, customer GID, or order ID"
            value={q}
            onChange={(v) => setParam("q", v)}
            autoComplete="off"
          />

          <ButtonGroup>
            <Button
              pressed={status === "active"}
              onClick={() => setParam("status", "active")}
            >
              Active
            </Button>
            <Button
              pressed={status === "consumed"}
              onClick={() => setParam("status", "consumed")}
            >
              Consumed
            </Button>
            <Button
              pressed={status === "expired"}
              onClick={() => setParam("status", "expired")}
            >
              Expired
            </Button>
            <Button
              pressed={status === "void"}
              onClick={() => setParam("status", "void")}
            >
              Void
            </Button>
            <Button
              pressed={status === "all"}
              onClick={() => setParam("status", "all")}
            >
              All
            </Button>
          </ButtonGroup>
        </InlineStack>

        <div style={{ marginTop: 16 }}>
          <Text as="p" variant="bodySm">
            Showing {rows.length} of {total}
          </Text>
        </div>

        <IndexTable
          resourceName={{ singular: "redemption", plural: "redemptions" }}
          itemCount={rows.length}
          headings={[
            { title: "Code" },
            { title: "Customer" },
            { title: "Points" },
            { title: "Value" },
            { title: "Status" },
            { title: "Issued" },
            { title: "Expires" },
            { title: "Consumed Order" },
          ]}
          selectable={false}
        >
          {rows.map((r, index) => (
            <IndexTable.Row id={r.id} key={r.id} position={index}>
              <IndexTable.Cell>
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  {r.code}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span" variant="bodySm">
                  {r.customerId}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>{r.pointsUsed}</IndexTable.Cell>
              <IndexTable.Cell>${(r.valueCents / 100).toFixed(2)}</IndexTable.Cell>
              <IndexTable.Cell>
                <Badge tone={statusTone(r.status)}>{r.status}</Badge>
              </IndexTable.Cell>
              <IndexTable.Cell>
                {new Date(r.issuedAt).toLocaleString()}
              </IndexTable.Cell>
              <IndexTable.Cell>
                {new Date(r.expiresAt).toLocaleString()}
              </IndexTable.Cell>
              <IndexTable.Cell>{r.consumedOrderId || "—"}</IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>

        <div style={{ marginTop: 16 }}>
          <InlineStack gap="200">
            <Button disabled={!canPrev} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button disabled={!canNext} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </InlineStack>
        </div>
      </Card>
    </Page>
  );
}
