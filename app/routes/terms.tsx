export default function Terms() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>Lions Creek Rewards — Terms of Service</h1>

      <p>
        By installing and using Lions Creek Rewards, you agree to these terms. This app is provided “as is” without
        warranty. You are responsible for verifying loyalty settings, testing in a non-production store, and ensuring the
        program’s terms are communicated to your customers.
      </p>

      <h2>Service description</h2>
      <p>
        Lions Creek Rewards awards and manages loyalty points based on Shopify order events, maintains a ledger and points
        balances, supports refund and cancellation reversals, and provides an optional customer-facing points dashboard.
      </p>

      <h2>Limitations</h2>
      <ul>
        <li>Points calculations are based on Shopify webhook payloads and configured eligibility rules.</li>
        <li>Reward issuance may require additional Shopify configuration or future enhancements (e.g., true discount codes).</li>
        <li>Service may be interrupted by Shopify platform changes, store configuration changes, or network outages.</li>
        <li>Points have no monetary value and cannot be exchanged for cash.</li>
      </ul>

      <h2>Support</h2>
      <p>
        Support is available by email at{" "}
        <a href="mailto:Support@TwoMenOnAYellowCouch.com">Support@TwoMenOnAYellowCouch.com</a>.
      </p>
    </main>
  );
}
