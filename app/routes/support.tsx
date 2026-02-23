// app/routes/support.tsx
export default function Support() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>Lions Creek Rewards — Support</h1>

      <p>
        For support, please email{" "}
        <a href="mailto:Support@TwoMenOnAYellowCouch.com">Support@TwoMenOnAYellowCouch.com</a>.
      </p>

      <h2>How it works (v1.5)</h2>
      <ul>
        <li>
          <strong>Earn:</strong> Points are awarded from Shopify order events (via webhooks), based on eligible net
          merchandise value after discounts.
        </li>
        <li>
          <strong>Reverse:</strong> Refunds and cancellations reverse points proportionally based on prior order snapshots
          so points don’t drift.
        </li>
        <li>
          <strong>Redeem:</strong> Customers generate a <em>real Shopify discount code</em> (single-use) from the Customer
          Account dashboard. One active code per customer at a time.
        </li>
        <li>
          <strong>Expiry:</strong> Issued discount codes expire after the configured window. Points expire after the
          configured inactivity window (enforced by a scheduled job).
        </li>
      </ul>

      <h2>Customer experience</h2>
      <ul>
        <li>
          <strong>Primary UI:</strong> Shopify <em>Customer Account UI Extension</em> (“Lions Creek Rewards” page in the
          customer account).
        </li>
        <li>
          <strong>Optional / legacy:</strong> Storefront App Proxy endpoints for backwards compatibility:
          <ul>
            <li>
              <code>/loyalty</code> (HTML route; used by older proxy-based flows)
            </li>
            <li>
              <code>/loyalty.json</code> (JSON endpoint for proxy/debug tooling)
            </li>
          </ul>
        </li>
      </ul>

      <h2>Operational endpoints</h2>
      <ul>
        <li>
          <strong>Webhooks:</strong> <code>/webhooks</code>
        </li>
        <li>
          <strong>Expiry job:</strong> <code>GET /jobs/expire</code> (use <code>X-Job-Token</code> or{" "}
          <code>Authorization: Bearer</code> if <code>JOB_TOKEN</code> is set)
        </li>
        <li>
          <strong>Customer Account API:</strong> <code>GET /api/customer/loyalty</code> and{" "}
          <code>POST /api/customer/redeem</code> (requires customer account session token)
        </li>
      </ul>

      <h2>Setup checklist</h2>
      <ol>
        <li>
          <strong>Admin settings:</strong> Open the app in Shopify Admin → configure earn rate, eligible collection
          handle, redemption mapping (points → $ value), and exclusions (tags).
        </li>
        <li>
          <strong>Customer Account page:</strong> Ensure the Customer Account UI extension is deployed and enabled in the
          store’s customer account.
        </li>
        <li>
          <strong>Webhooks:</strong> Confirm required webhooks are registered (orders paid, refunds, cancellations, and
          Shopify privacy topics). The app’s webhook handler is <code>/webhooks</code>.
        </li>
        <li>
          <strong>Expiry job:</strong> Schedule a daily <code>GET</code> to <code>/jobs/expire</code>. If <code>JOB_TOKEN</code> is
          configured on the server, include <code>X-Job-Token</code> (or Bearer auth).
        </li>
      </ol>

      <h2>Common issues</h2>
      <ul>
        <li>
          <strong>Redemption fails:</strong> Common causes are insufficient points, a missing eligible collection handle,
          or a points amount that isn’t in the configured redemption steps.
        </li>
        <li>
          <strong>“I already have a code”:</strong> The system enforces one active code at a time. Use the existing code
          before creating a new one.
        </li>
        <li>
          <strong>No points awarded:</strong> The order must have a customer (not guest), and the customer/products must
          not be excluded by configured tags.
        </li>
        <li>
          <strong>Code doesn’t apply at checkout:</strong> Ensure the cart contains eligible products (in the configured
          eligible collection) and meets any minimum order requirement.
        </li>
      </ul>
    </main>
  );
}
