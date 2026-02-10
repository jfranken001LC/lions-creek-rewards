export default function Privacy() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>Lions Creek Rewards — Privacy Policy</h1>

      <p>
        Lions Creek Rewards is a Shopify app that tracks loyalty points for customers of a Shopify store. It awards points
        from Shopify order events, maintains a points ledger and balance, and provides an optional customer-facing points
        dashboard via Shopify App Proxy.
      </p>

      <h2>Data we store</h2>
      <p>
        The app stores the minimum necessary data to operate a loyalty program:
      </p>
      <ul>
        <li>Shop domain (e.g., <code>example.myshopify.com</code>)</li>
        <li>Shopify Customer ID (numeric/string identifier)</li>
        <li>Shopify Order ID for points snapshots</li>
        <li>Points ledger entries (earn/redeem/reversal/expiry/adjust)</li>
        <li>Points balances and last activity timestamps</li>
        <li>Webhook event IDs for idempotency (deduplication)</li>
      </ul>

      <p>
        The app does not intentionally store customer names, addresses, or payment details. Shopify remains the system of
        record for customer PII.
      </p>

      <h2>How data is used</h2>
      <p>
        Data is used only to calculate, track, and display points and redemptions, and to support auditability (ledger)
        and refund/cancellation safety.
      </p>

      <h2>Webhooks &amp; compliance</h2>
      <p>
        To comply with Shopify platform requirements, the app supports Shopify’s required privacy webhooks:
        <strong> customers/data_request</strong>, <strong>customers/redact</strong>, and <strong>shop/redact</strong>.
      </p>

      <h2>Contact</h2>
      <p>
        If you have questions about this policy, contact{" "}
        <a href="mailto:Support@TwoMenOnAYellowCouch.com">Support@TwoMenOnAYellowCouch.com</a>.
      </p>
    </main>
  );
}
