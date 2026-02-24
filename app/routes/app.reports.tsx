import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";
import { Page, Layout, Card, BlockStack, Text, Button } from "@shopify/polaris";
import db from "../db.server";
import { requireAdmin } from "../lib/shopify.server";

async function sumByType(shop: string, type: string) {
  const rows = await db.pointsLedger.aggregate({
    where: { shop, type: type as any },
    _sum: { delta: true },
    _count: { _all: true },
  });
  return { sum: rows._sum.delta ?? 0, count: rows._count._all ?? 0 };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireAdmin(request);
  const shop = session.shop;

  const [earn, redeem, expiry, reversal, adjust] = await Promise.all([
    sumByType(shop, "EARN"),
    sumByType(shop, "REDEEM"),
    sumByType(shop, "EXPIRY"),
    sumByType(shop, "REVERSAL"),
    sumByType(shop, "ADJUST"),
  ]);

  const totalCustomers = await db.customerPointsBalance.count({ where: { shop } });
  const totalRedemptions = await db.redemption.count({ where: { shop } });

  return data({
    shop,
    stats: {
      ledger: { earn, redeem, expiry, reversal, adjust },
      totalCustomers,
      totalRedemptions,
    },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const session = await requireAdmin(request);
  const shop = session.shop;

  const rows = await db.pointsLedger.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: { createdAt: true, type: true, delta: true },
  });

  const byDay = new Map<string, { EARN: number; REDEEM: number; EXPIRY: number; REVERSAL: number; ADJUST: number }>();
  for (const r of rows) {
    const day = r.createdAt.toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { EARN: 0, REDEEM: 0, EXPIRY: 0, REVERSAL: 0, ADJUST: 0 });
    const b = byDay.get(day)!;
    b[r.type as keyof typeof b] += r.delta;
  }

  const header = ["date", "earn_points", "redeem_points", "expiry_points", "reversal_points", "adjust_points", "net_points"];
  const lines = [header.join(",")];

  const sorted = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [day, b] of sorted) {
    const net = b.EARN + b.ADJUST + b.REVERSAL + b.REDEEM + b.EXPIRY;
    lines.push([day, b.EARN, b.REDEEM, b.EXPIRY, b.REVERSAL, b.ADJUST, net].join(","));
  }

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="loyalty-report-${shop}-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

export default function ReportsPage() {
  const { shop, stats } = useLoaderData<typeof loader>();

  return (
    <Page title="Reports">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="p" variant="bodyMd">
                Shop: <strong>{shop}</strong>
              </Text>

              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th align="left">Type</th>
                    <th align="right">Count</th>
                    <th align="right">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>EARN</td>
                    <td align="right">{stats.ledger.earn.count}</td>
                    <td align="right">{stats.ledger.earn.sum}</td>
                  </tr>
                  <tr>
                    <td>REDEEM</td>
                    <td align="right">{stats.ledger.redeem.count}</td>
                    <td align="right">{stats.ledger.redeem.sum}</td>
                  </tr>
                  <tr>
                    <td>Expiry</td>
                    <td align="right">{stats.ledger.expiry.count}</td>
                    <td align="right">{stats.ledger.expiry.sum}</td>
                  </tr>
                  <tr>
                    <td>REVERSAL</td>
                    <td align="right">{stats.ledger.reversal.count}</td>
                    <td align="right">{stats.ledger.reversal.sum}</td>
                  </tr>
                  <tr>
                    <td>ADJUST</td>
                    <td align="right">{stats.ledger.adjust.count}</td>
                    <td align="right">{stats.ledger.adjust.sum}</td>
                  </tr>
                </tbody>
              </table>

              <Text as="p" variant="bodyMd">
                Customers: <strong>{stats.totalCustomers}</strong> • Redemptions: <strong>{stats.totalRedemptions}</strong>
              </Text>

              <form method="post">
                <Button submit>Download CSV</Button>
              </form>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
