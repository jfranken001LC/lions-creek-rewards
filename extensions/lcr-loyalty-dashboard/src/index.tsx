import "@shopify/ui-extensions/preact";
import { render } from "preact";

function LoyaltyDashboard() {
  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
      <h2 style={{ margin: "0 0 8px" }}>Lions Creek Rewards</h2>
      <p style={{ margin: 0, opacity: 0.8 }}>
        Loyalty dashboard extension is installed and rendering correctly.
      </p>
    </div>
  );
}

// Customer Account UI extension entrypoint.
// Shopify loads this module for target: customer-account.page.render
export default async function main() {
  render(<LoyaltyDashboard />, document.body);
}
