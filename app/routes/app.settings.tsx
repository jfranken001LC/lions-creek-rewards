import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, Link, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getShopSettings,
  upsertShopSettings,
  V1_REDEMPTION_STEPS,
  V1_REDEMPTION_VALUE_MAP,
} from "../lib/shopSettings.server";

function csvToList(raw: FormDataEntryValue | null): string[] {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

type ActionData =
  | { ok: true; message: string }
  | { ok: false; error: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await getShopSettings(shop);
  return data({ shop, settings });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();

  const earnRate = Number(form.get("earnRate") ?? 1);
  const redemptionMinOrder = Number(form.get("redemptionMinOrder") ?? 0);

  try {
    await upsertShopSettings(shop, {
      earnRate,
      redemptionMinOrder,
      excludedCustomerTags: csvToList(form.get("excludedCustomerTags")),
      includeProductTags: csvToList(form.get("includeProductTags")),
      excludeProductTags: csvToList(form.get("excludeProductTags")),
    });

    return data<ActionData>({ ok: true, message: "Settings saved." });
  } catch (e: any) {
    return data<ActionData>({ ok: false, error: String(e?.message ?? e) }, { status: 400 });
  }
};

export default function SettingsPage() {
  const { shop, settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();

  return (
    <div style={{ padding: 18, maxWidth: 980 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>Program Settings</h1>
        <Link to="/app" style={{ opacity: 0.8 }}>
          ← Back
        </Link>
      </div>

      <div style={{ opacity: 0.7, marginTop: 6, marginBottom: 14 }}>Shop: {shop}</div>

      {actionData ? (
        <div
          style={{
            border: `1px solid ${actionData.ok ? "#b7e4c7" : "#ffccd5"}`,
            background: actionData.ok ? "#ecfdf5" : "#fff1f2",
            padding: 12,
            borderRadius: 12,
            marginBottom: 14,
          }}
        >
          {actionData.ok ? actionData.message : actionData.error}
        </div>
      ) : null}

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Earning rules</h2>

        <Form method="post" style={{ display: "grid", gap: 12, maxWidth: 740 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Earn rate</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Points per $1 of <em>eligible net merchandise</em> on Paid orders. v1 is typically 1.
            </span>
            <input name="earnRate" type="number" min={1} max={100} step={1} defaultValue={settings.earnRate} />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Excluded customer tags</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Customers with any of these tags are excluded from earning and redemption.
            </span>
            <input
              name="excludedCustomerTags"
              type="text"
              placeholder="Wholesale, Staff"
              defaultValue={settings.excludedCustomerTags.join(", ")}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Include product tags (optional)</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              If set, <strong>only</strong> products with at least one of these tags are eligible.
            </span>
            <input
              name="includeProductTags"
              type="text"
              placeholder="RewardsEligible"
              defaultValue={settings.includeProductTags.join(", ")}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Exclude product tags (optional)</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Products with any of these tags are never eligible.
            </span>
            <input
              name="excludeProductTags"
              type="text"
              placeholder="NoRewards"
              defaultValue={settings.excludeProductTags.join(", ")}
            />
          </label>

          <button type="submit" style={{ width: 180 }}>
            Save Settings
          </button>
        </Form>
      </section>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
        <h2 style={{ marginTop: 0 }}>Redemption rules (v1)</h2>

        <Form method="post" style={{ display: "grid", gap: 12, maxWidth: 740 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Minimum order subtotal to redeem (CAD)</span>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              Applied to generated discount codes as a Shopify minimum-subtotal requirement.
            </span>
            <input
              name="redemptionMinOrder"
              type="number"
              min={0}
              max={100000}
              step={1}
              defaultValue={settings.redemptionMinOrder}
            />
          </label>

          <div style={{ border: "1px dashed #e5e5e5", borderRadius: 12, padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Fixed redemption steps (hard-locked for v1)</div>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
              {V1_REDEMPTION_STEPS.map((pts) => (
                <li key={pts}>
                  {pts} points → ${V1_REDEMPTION_VALUE_MAP[String(pts)].toFixed(0)} off
                </li>
              ))}
            </ul>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
              Max redeemable per order in v1 is 1000 points.
            </div>
          </div>

          <button type="submit" style={{ width: 180 }}>
            Save Settings
          </button>
        </Form>
      </section>
    </div>
  );
}
