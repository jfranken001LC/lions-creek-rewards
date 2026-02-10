import { data, Form, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

type SettingsShape = {
  earnRate: number;
  redemptionMinOrder: number;
  excludedCustomerTags: string[];
  includeProductTags: string[];
  excludeProductTags: string[];
};

function parseCsvList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const defaults: SettingsShape = {
    earnRate: 1,
    redemptionMinOrder: 0,
    excludedCustomerTags: ["Wholesale"],
    includeProductTags: [],
    excludeProductTags: [],
  };

  const settings = await db.shopSettings.findUnique({ where: { shop } }).catch(() => null);
  return data({
    shop,
    settings: settings ? { ...defaults, ...settings } : defaults,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");

  if (intent === "saveSettings") {
    const earnRate = Number(form.get("earnRate") ?? 1) || 1;
    const redemptionMinOrder = Number(form.get("redemptionMinOrder") ?? 0) || 0;

    const excludedCustomerTags = parseCsvList(String(form.get("excludedCustomerTags") ?? ""));
    const includeProductTags = parseCsvList(String(form.get("includeProductTags") ?? ""));
    const excludeProductTags = parseCsvList(String(form.get("excludeProductTags") ?? ""));

    await db.shopSettings.upsert({
      where: { shop },
      create: {
        shop,
        earnRate,
        redemptionMinOrder,
        excludedCustomerTags,
        includeProductTags,
        excludeProductTags,
        updatedAt: new Date(),
      },
      update: {
        earnRate,
        redemptionMinOrder,
        excludedCustomerTags,
        includeProductTags,
        excludeProductTags,
        updatedAt: new Date(),
      },
    });

    return data({ ok: true, message: "Settings saved." });
  }

  if (intent === "adjustPoints") {
    const customerId = String(form.get("customerId") ?? "").trim();
    const delta = Math.trunc(Number(form.get("delta") ?? 0) || 0);
    const reason = String(form.get("reason") ?? "").trim();

    if (!customerId || !delta || !reason) {
      return data({ ok: false, message: "CustomerId, delta, and reason are required." }, { status: 400 });
    }

    await db.$transaction(async (tx) => {
      await tx.pointsLedger.create({
        data: {
          shop,
          customerId,
          type: "ADJUST",
          delta,
          source: "ADMIN",
          sourceId: String(session.id),
          description: `Admin adjust: ${reason}`,
          createdAt: new Date(),
        },
      });

      // Ensure balance row exists
      const bal = await tx.customerPointsBalance.upsert({
        where: { shop_customerId: { shop, customerId } },
        create: {
          shop,
          customerId,
          balance: delta,
          lifetimeEarned: Math.max(0, delta),
          lifetimeRedeemed: 0,
          lastActivityAt: new Date(),
        },
        update: {
          balance: { increment: delta },
          lastActivityAt: new Date(),
        },
      });

      if (bal.balance < 0) {
        await tx.customerPointsBalance.update({
          where: { shop_customerId: { shop, customerId } },
          data: { balance: 0 },
        });
      }
    });

    return data({ ok: true, message: "Adjustment applied." });
  }

  if (intent === "lookupCustomer") {
    const q = String(form.get("q") ?? "").trim();
    if (!q) return data({ ok: false, message: "Enter a customer ID (numeric) or email." }, { status: 400 });

    // v1: we only store Shopify customerId. Email lookup requires Admin API in a later iteration.
    // For now accept customerId directly.
    const customerId = q;

    const balance = await db.customerPointsBalance.findUnique({
      where: { shop_customerId: { shop, customerId } },
    });

    const ledger = await db.pointsLedger.findMany({
      where: { shop, customerId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return data({ ok: true, customerId, balance, ledger });
  }

  return data({ ok: false, message: "Unknown action." }, { status: 400 });
};

export default function AdminHome() {
  const { shop, settings } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: 16, maxWidth: 980 }}>
      <h1 style={{ marginBottom: 6 }}>Lions Creek Rewards</h1>
      <div style={{ opacity: 0.7, marginBottom: 18 }}>Shop: {shop}</div>

      <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Program Settings</h2>
        <Form method="post">
          <input type="hidden" name="_intent" value="saveSettings" />

          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
            <label>
              Earn rate (points per $1 eligible net)
              <input name="earnRate" defaultValue={settings.earnRate} type="number" step="1" min="0" />
            </label>

            <label>
              Minimum order subtotal to redeem (CAD)
              <input name="redemptionMinOrder" defaultValue={settings.redemptionMinOrder} type="number" step="1" min="0" />
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              Excluded customer tags (CSV) — e.g. Wholesale
              <input name="excludedCustomerTags" defaultValue={(settings.excludedCustomerTags ?? []).join(", ")} />
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              Include product tags (CSV) — blank means “all eligible”
              <input name="includeProductTags" defaultValue={(settings.includeProductTags ?? []).join(", ")} />
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              Exclude product tags (CSV)
              <input name="excludeProductTags" defaultValue={(settings.excludeProductTags ?? []).join(", ")} />
            </label>
          </div>

          <button style={{ marginTop: 12 }} type="submit">
            Save settings
          </button>
        </Form>

        <p style={{ marginTop: 12, opacity: 0.8 }}>
          Points are earned on <code>orders/paid</code>. Refunds/cancellations reverse proportionally. Redemptions are 500=$10
          and 1000=$20 (v1). :contentReference[oaicite:2]{index=2}
        </p>
      </section>

      <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Customer lookup</h2>
        <Form method="post" style={{ display: "flex", gap: 8, alignItems: "end" }}>
          <input type="hidden" name="_intent" value="lookupCustomer" />
          <label style={{ flex: 1 }}>
            Customer ID (Shopify)
            <input name="q" placeholder="e.g. 1234567890" />
          </label>
          <button type="submit">Lookup</button>
        </Form>

        <LookupResults />
      </section>

      <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14 }}>
        <h2 style={{ marginTop: 0 }}>Manual points adjustment</h2>
        <Form method="post" style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
          <input type="hidden" name="_intent" value="adjustPoints" />

          <label>
            Customer ID
            <input name="customerId" placeholder="1234567890" />
          </label>

          <label>
            Delta (+/- points)
            <input name="delta" type="number" step="1" />
          </label>

          <label style={{ gridColumn: "1 / -1" }}>
            Reason (required)
            <input name="reason" placeholder="e.g. goodwill adjustment for damaged bottle" />
          </label>

          <button type="submit" style={{ gridColumn: "1 / -1" }}>
            Apply adjustment
          </button>
        </Form>
      </section>
    </div>
  );
}

function LookupResults() {
  // In RR7, action data is available through navigation APIs; to keep this “drop-in” minimal,
  // we simply instruct to rely on network response until you add a proper toast/UX.
  return (
    <div style={{ marginTop: 12, opacity: 0.75 }}>
      After lookup, view the JSON response in the Network tab (next iteration will render it nicely).
    </div>
  );
}
