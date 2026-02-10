import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // When Shopify Admin loads an embedded app, it appends params like:
  // embedded=1, host, shop, session/id_token
  const isEmbedded =
    url.searchParams.get("embedded") === "1" ||
    url.searchParams.has("host") ||
    url.searchParams.has("session") ||
    url.searchParams.has("id_token");

  const hasShop = url.searchParams.has("shop");

  // If Shopify is loading the app, route into the embedded UI layout (/app)
  if (isEmbedded && hasShop) {
    return redirect(`/app${url.search}`);
  }

  // Otherwise, show the public landing page
  return null;
};

export default function Index() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 32, maxWidth: 980, margin: "0 auto" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Lions Creek Rewards</h1>
        <p style={{ marginTop: 8, fontSize: 18, opacity: 0.85 }}>
          A simple Shopify loyalty program: earn points on paid orders, redeem rewards, and view points history—online and
          POS-compatible via Shopify orders.
        </p>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Earn automatically</h3>
          <p style={{ marginBottom: 0 }}>
            Points are awarded from <strong>orders/paid</strong> webhooks and tracked in a ledger for auditability.
          </p>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Refund-safe</h3>
          <p style={{ marginBottom: 0 }}>
            Refunds and cancellations automatically reverse previously awarded points proportionally and idempotently.
          </p>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Customer dashboard</h3>
          <p style={{ marginBottom: 0 }}>
            Customers view balance and redeem rewards via a signed <strong>Shopify App Proxy</strong> page.
          </p>
        </div>
      </section>

      <section style={{ marginTop: 22, border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>For merchants</h3>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Open the app from <strong>Shopify Admin → Apps</strong> (embedded UI).</li>
          <li>Configure earn rate, exclusions, and minimum redemption order subtotal in the app settings.</li>
          <li>Set up webhooks and App Proxy during installation (instructions in Support).</li>
        </ul>
      </section>

      <footer style={{ marginTop: 36, borderTop: "1px solid #eee", paddingTop: 18, fontSize: 14 }}>
        <a href="/support" style={{ marginRight: 14 }}>
          Support
        </a>
        <a href="/privacy" style={{ marginRight: 14 }}>
          Privacy
        </a>
        <a href="/terms">Terms</a>
      </footer>
    </main>
  );
}
