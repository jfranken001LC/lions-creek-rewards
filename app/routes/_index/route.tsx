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

  // If Shopify is loading the app, immediately route into the embedded UI layout (/app)
  if (isEmbedded && hasShop) {
    return redirect(`/app${url.search}`);
  }

  // Otherwise, show the public landing page (no shop-domain input)
  return null;
};

export default function Index() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 32, maxWidth: 980, margin: "0 auto" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Basket Booster Discounts</h1>
        <p style={{ marginTop: 8, fontSize: 18 }}>
          Automatically apply an order discount when a cart reaches a configurable Bottle Equivalent (BE) threshold.
        </p>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Bottle Equivalent logic</h3>
          <p style={{ marginBottom: 0 }}>
            Uses your product metafield <strong>loyalty.bottle_equivalent</strong> to convert mixed bottle sizes into a
            single BE total.
          </p>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Scales automatically</h3>
          <p style={{ marginBottom: 0 }}>
            Every <strong>Trigger BE</strong> earns <strong>Amount</strong> off the order subtotal (e.g., 6 BE → $10,
            12 BE → $20, 18 BE → $30).
          </p>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Open from Shopify Admin</h3>
          <p style={{ marginBottom: 0 }}>
            After installation, open the app from <strong>Shopify Admin → Apps</strong>. No separate login is required.
          </p>
        </div>
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
