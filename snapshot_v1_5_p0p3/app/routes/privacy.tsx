// app/routes/privacy.tsx
export default function Privacy() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>Lions Creek Rewards — Privacy Policy</h1>

      <p>
        Lions Creek Rewards is a Shopify app that tracks loyalty points for customers of a Shopify store. It awards points
        from Shopify order events, maintains a points ledger and balance, and allows customers to redeem points for Shopify
        discount codes via a Customer Account page.
      </p>

      <h2>Data we store</h2>
      <p>The app stores the minimum necessary data to operate the loyalty program, including:</p>
      <ul>
        <li>Shop domain (e.g., <code>example.myshopify.com</code>)</li>
        <li>Shopify Customer ID (numeric identifier)</li>
        <li>Shopify Order IDs and order points snapshots (for accurate reversals)</li>
        <li>Points ledger entries (earn, redeem, reversal, expiry, adjust)</li>
        <li>Points balances and last-activity timestamps</li>
        <li>Redemption records (points redeemed, discount code, expiry, and discount node reference)</li>
        <li>Webhook delivery metadata for idempotency/deduplication (topic, webhook id, timestamps, outcomes)</li>
        <li>App configuration settings (earn rate, redemption mapping, exclusions, eligible collection handle)</li>
      </ul>

      <p>
        The app does not intentionally store customer names, shipping addresses, payment details, or full order contents.
        Shopify remains the system of record for customer PII.
      </p>

      <h2>Shopify privacy webhooks</h2>
      <p>
        Shopify may send privacy-related webhooks (<strong>customers/data_request</strong>, <strong>customers/redact</strong>,{" "}
        and <strong>shop/redact</strong>). The app currently logs these requests to support compliance processing and audit.
        Logged payloads may include customer identifiers and other information Shopify provides in those requests.
      </p>

      <h2>How data is used</h2>
      <p>
        Data is used only to calculate, track, and display loyalty points and redemptions, provide auditability (ledger),
        and ensure refund/cancellation safety.
      </p>

      <h2>Contact</h2>
      <p>
        If you have questions about this policy, contact{" "}
        <a href="mailto:Support@TwoMenOnAYellowCouch.com">Support@TwoMenOnAYellowCouch.com</a>.
      </p>
    </main>
  );
}
