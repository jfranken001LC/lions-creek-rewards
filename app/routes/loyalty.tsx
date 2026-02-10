import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, useLoaderData } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";

function verifyAppProxyHmac(query: URLSearchParams, apiSecret: string): boolean {
  const hmac = query.get("hmac");
  if (!hmac || !apiSecret) return false;

  const pairs: string[] = [];
  for (const [k, v] of Array.from(query.entries())) {
    if (k === "hmac" || k === "signature") continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();

  const message = pairs.join("&");
  const digest = crypto.createHmac("sha256", apiSecret).update(message).digest("hex");

  // NOTE: Shopify sends lowercase hex for app-proxy hmac.
  return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmac, "utf8"));
}

function clampInt(n: number, min: number, max: number): number {
  const x = Math.floor(n);
  return Math.max(min, Math.min(max, x));
}

async function getShopSettings(shop: string) {
  const defaults = {
    earnRate: 1,
    redemptionMinOrder: 0,
    redemptionSteps: [500, 1000],
    redemptionValueMap: { "500": 10, "1000": 20 },
  };

  const s = await db.shopSettings.findUnique({ where: { shop } }).catch(() => null);

  // Normalize Json fields into plain JS types
  const normalized = {
    ...defaults,
    ...(s ?? {}),
    excludedCustomerTags: (s as any)?.excludedCustomerTags ?? [],
    includeProductTags: (s as any)?.includeProductTags ?? [],
    excludeProductTags: (s as any)?.excludeProductTags ?? [],
    redemptionSteps: (s as any)?.redemptionSteps ?? defaults.redemptionSteps,
    redemptionValueMap: (s as any)?.redemptionValueMap ?? defaults.redemptionValueMap,
  };

  return normalized;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const q = url.searchParams;

  const shop = (q.get("shop") ?? "").toLowerCase();
  const customerId = q.get("logged_in_customer_id") ?? q.get("customer_id") ?? "";

  const ok = verifyAppProxyHmac(q, process.env.SHOPIFY_API_SECRET ?? "");
  if (!ok || !shop || !customerId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const settings = await getShopSettings(shop);

  const balanceRow = await db.customerPointsBalance
    .findUnique({ where: { shop_customerId: { shop, customerId } } })
    .catch(() => null);

  const ledger = await db.pointsLedger.findMany({
    where: { shop, customerId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const balance = balanceRow?.balance ?? 0;
  const lastActivityAt = balanceRow?.lastActivityAt ?? null;
  const expiresOn = lastActivityAt
    ? new Date(new Date(lastActivityAt).getTime() + 365 * 24 * 60 * 60 * 1000)
    : null;

  return data({
    shop,
    customerId,
    settings,
    balance,
    lastActivityAt,
    expiresOn,
    ledger,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const q = url.searchParams;

  const shop = (q.get("shop") ?? "").toLowerCase();
  const customerId = q.get("logged_in_customer_id") ?? q.get("customer_id") ?? "";

  const ok = verifyAppProxyHmac(q, process.env.SHOPIFY_API_SECRET ?? "");
  if (!ok || !shop || !customerId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");

  if (intent !== "redeem") {
    return data({ ok: false, message: "Unknown action." }, { status: 400 });
  }

  const requested = Number(form.get("points") ?? 0) || 0;
  const points = clampInt(requested, 0, 1000);

  if (points != 500 && points != 1000) {
    return data({ ok: false, message: "Redemptions must be 500 or 1000 points." }, { status: 400 });
  }

  const settings = await getShopSettings(shop);

  const active = await db.redemption.findFirst({
    where: { shop, customerId, status: { in: ["ISSUED", "APPLIED"] } },
    orderBy: { createdAt: "desc" },
  });
  if (active) {
    return data(
      { ok: false, message: `You already have an active reward: ${active.pointsSpent} points.` },
      { status: 409 },
    );
  }

  const bal = await db.customerPointsBalance
    .findUnique({ where: { shop_customerId: { shop, customerId } } })
    .catch(() => null);

  const currentBalance = bal?.balance ?? 0;
  if (currentBalance < points) {
    return data({ ok: false, message: "Insufficient points." }, { status: 400 });
  }

  const value = Number((settings as any)?.redemptionValueMap?.[String(points)] ?? 0) || (points === 500 ? 10 : 20);
  const code = `LCR-${customerId.slice(-6)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  await db.$transaction(async (tx) => {
    await tx.pointsLedger.create({
      data: {
        shop,
        customerId,
        type: "REDEEM",
        delta: -points,
        source: "REDEMPTION",
        sourceId: code,
        description: `Redeemed ${points} points for $${value} reward code`,
        createdAt: new Date(),
      },
    });

    await tx.customerPointsBalance.upsert({
      where: { shop_customerId: { shop, customerId } },
      create: {
        shop,
        customerId,
        balance: Math.max(0, currentBalance - points),
        lifetimeEarned: 0,
        lifetimeRedeemed: points,
        lastActivityAt: new Date(),
      },
      update: {
        balance: { decrement: points },
        lifetimeRedeemed: { increment: points },
        lastActivityAt: new Date(),
      },
    });

    // Clamp to >= 0
    const updated = await tx.customerPointsBalance.findUnique({
      where: { shop_customerId: { shop, customerId } },
    });
    if (updated && updated.balance < 0) {
      await tx.customerPointsBalance.update({
        where: { shop_customerId: { shop, customerId } },
        data: { balance: 0 },
      });
    }

    await tx.redemption.create({
      data: {
        shop,
        customerId,
        pointsSpent: points,
        value,
        code,
        status: "ISSUED",
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
  });

  return data({ ok: true, message: "Reward issued.", code, value });
};

export default function LoyaltyDashboard() {
  const { balance, ledger, expiresOn, lastActivityAt, settings } = useLoaderData<typeof loader>();

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto", padding: 18, maxWidth: 980 }}>
      <h1 style={{ margin: 0 }}>Lions Creek Rewards</h1>
      <p style={{ marginTop: 6, opacity: 0.8 }}>
        Earn 1 point per $1 on eligible merchandise. Redeem 500 points for $10 or 1000 points for $20.
      </p>

      <section style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr", marginTop: 12 }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 14, opacity: 0.7 }}>Current balance</div>
          <div style={{ fontSize: 34, fontWeight: 700 }}>{balance}</div>
        </div>

        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 14, opacity: 0.7 }}>Expiry policy</div>
          <div style={{ fontSize: 14, marginTop: 6 }}>
            {lastActivityAt ? (
              <>
                Last activity: <strong>{new Date(lastActivityAt).toLocaleDateString()}</strong>
                <br />
                Estimated expiry (if no activity): <strong>{expiresOn ? new Date(expiresOn).toLocaleDateString() : "—"}</strong>
              </>
            ) : (
              <>No activity yet. Points expire after 12 months of inactivity.</>
            )}
          </div>
        </div>
      </section>

      <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14, marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>Redeem</h2>
        <div style={{ opacity: 0.8, marginBottom: 10 }}>
          Minimum order to redeem: <strong>${settings.redemptionMinOrder}</strong>
        </div>

        <Form method="post" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
          <input type="hidden" name="_intent" value="redeem" />
          <label>
            Choose reward
            <select name="points" defaultValue="500">
              <option value="500">500 points → $10</option>
              <option value="1000">1000 points → $20</option>
            </select>
          </label>
          <button type="submit">Generate reward</button>
        </Form>

        <p style={{ marginTop: 10, fontSize: 13, opacity: 0.75 }}>
          v1: this issues a one-time code stored in the app. Next iteration wires it to a Shopify discount code via Admin API.
        </p>
      </section>

      <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14, marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>Points history</h2>
        <div style={{ overflowX: "auto" }}>
          <table cellPadding={8} style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
                <th>Date</th>
                <th>Type</th>
                <th>Delta</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {ledger.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ opacity: 0.7 }}>
                    No points activity yet.
                  </td>
                </tr>
              ) : (
                ledger.map((e: any) => (
                  <tr key={e.id} style={{ borderBottom: "1px solid #f3f3f3" }}>
                    <td>{new Date(e.createdAt).toLocaleDateString()}</td>
                    <td>{e.type}</td>
                    <td style={{ fontWeight: 600 }}>{e.delta}</td>
                    <td style={{ opacity: 0.85 }}>{e.description}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
