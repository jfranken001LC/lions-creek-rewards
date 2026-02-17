import type { LoaderFunctionArgs } from "react-router";
import { json, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const now = new Date();

  const [activeCustomerCount, activeRedemptionCount] = await Promise.all([
    db.customerPointsBalance.count({ where: { shop } }),
    db.redemption.count({
      where: {
        shop,
        status: { in: ["ISSUED", "APPLIED"] },
        expiresAt: { gt: now },
      },
    }),
  ]);

  return json({ shop, activeCustomerCount, activeRedemptionCount });
}

export default function AppIndex() {
  const { shop, activeCustomerCount, activeRedemptionCount } =
    useLoaderData<typeof loader>();

  return (
    <div style={{ padding: "16px" }}>
      <h1 style={{ margin: 0 }}>Lions Creek Rewards</h1>
      <p style={{ marginTop: 8, opacity: 0.8 }}>
        Connected shop: <b>{shop}</b>
      </p>

      <div style={{ display: "flex", gap: 16, marginTop: 16, flexWrap: "wrap" }}>
        <div style={{ padding: 16, border: "1px solid #eee", borderRadius: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Customers tracked</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{activeCustomerCount}</div>
        </div>

        <div style={{ padding: 16, border: "1px solid #eee", borderRadius: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Active redemptions</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{activeRedemptionCount}</div>
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <h2 style={{ marginBottom: 8 }}>Admin</h2>
        <ul>
          <li>
            <a href="/app/customers">Customers</a>
          </li>
          <li>
            <a href="/app/redemptions">Redemptions</a>
          </li>
          <li>
            <a href="/app/reports">Reports</a>
          </li>
          <li>
            <a href="/app/settings">Settings</a>
          </li>
          <li>
            <a href="/support">Support</a>
          </li>
        </ul>
      </div>
    </div>
  );
}
