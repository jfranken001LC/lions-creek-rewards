import { data, Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [customerCount, balanceAgg, activeRedemptions, failedWebhooks24h] = await Promise.all([
    db.customerPointsBalance.count({ where: { shop } }),
    db.customerPointsBalance.aggregate({ where: { shop }, _sum: { balance: true } }),
    db.redemption.count({ where: { shop, status: "ISSUED" } }),
    db.webhookEvent.count({ where: { shop, outcome: "FAILED", receivedAt: { gte: since24h } } }),
  ]);

  return data({
    shop,
    stats: {
      customersWithBalance: customerCount,
      outstandingPoints: balanceAgg._sum.balance ?? 0,
      activeRedemptions,
      failedWebhooks24h,
    },
  });
};

export default function AdminIndex() {
  const { shop, stats } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: 18, maxWidth: 980 }}>
      <h1 style={{ margin: 0 }}>Lions Creek Rewards — Admin</h1>
      <div style={{ opacity: 0.7, marginTop: 6, marginBottom: 14 }}>Shop: {shop}</div>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Quick stats</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Customers with a balance row</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{stats.customersWithBalance}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Outstanding points</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{stats.outstandingPoints}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Active (ISSUED) redemptions</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{stats.activeRedemptions}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Webhook failures (last 24h)</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{stats.failedWebhooks24h}</div>
          </div>
        </div>
      </section>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Admin tools</h2>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>
            <Link to="/app/settings">Program settings</Link>
          </li>
          <li>
            <Link to="/app/customers">Customer lookup + manual adjustments</Link>
          </li>
          <li>
            <Link to="/app/reports">Reports + CSV export</Link>
          </li>
          <li>
            <Link to="/app/webhooks">Webhook processing logs</Link>
          </li>
        </ul>
        <div style={{ marginTop: 10, opacity: 0.75 }}>
          Start with <Link to="/app/settings">Program settings</Link> to configure eligibility tags and the minimum order
          subtotal for redemption.
        </div>
      </section>
    </div>
  );
}
