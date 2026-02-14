// app/routes/terms.tsx
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
        balances, supports refund and cancellation reversals, and enables customers to redeem points for Shopify discount
        codes through a Customer Account page.
      </p>

      <h2>Redemptions</h2>
      <ul>
        <li>Points are not cash and have no monetary value outside the loyalty program.</li>
        <li>Redemption codes are intended for the specific customer who generated them and are single-use.</li>
        <li>Only one active redemption code may exist per customer at a time.</li>
        <li>Unused codes expire; when a code expires unused, points may be restored automatically.</li>
      </ul>

      <h2>Limitations</h2>
      <ul>
        <li>Points calculations are based on Shopify webhook payloads and configured eligibility rules.</li>
        <li>Service may be interrupted by Shopify platform changes, store configuration changes, or network outages.</li>
        <li>Store owners are responsible for communicating program rules, exclusions, and expiry terms to customers.</li>
      </ul>

      <h2>Support</h2>
      <p>
        Support is available by email at{" "}
        <a href="mailto:Support@TwoMenOnAYellowCouch.com">Support@TwoMenOnAYellowCouch.com</a>.
      </p>
    </main>
  );
}
