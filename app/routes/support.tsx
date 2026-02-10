export default function Support() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>Lions Creek Rewards — Support</h1>

      <p>
        For support, please email{" "}
        <a href="mailto:Support@TwoMenOnAYellowCouch.com">Support@TwoMenOnAYellowCouch.com</a>.
      </p>

      <h2>How it works (v1.1)</h2>
      <ul>
        <li>
          <strong>Earn:</strong> Points are awarded on <code>orders/paid</code> webhooks based on eligible net merchandise.
        </li>
        <li>
          <strong>Reverse:</strong> <code>refunds/create</code> reverses points proportionally; <code>orders/cancelled</code>{" "}
          reverses remaining points awarded for that order.
        </li>
        <li>
          <strong>Redeem:</strong> Customers can generate a reward via the customer dashboard (App Proxy). (In v1.1 this
          issues a tracked code; issuing a real Shopify discount code is the next increment.)
        </li>
        <li>
          <strong>Expiry:</strong> Points expire after 12 months of inactivity, enforced by a daily job endpoint.
        </li>
      </ul>

      <h2>Setup checklist</h2>
      <ol>
        <li>
          <strong>Webhooks:</strong> In Shopify Admin, register webhooks to your app’s <code>/webhooks</code> endpoint:
          <ul>
            <li><code>orders/paid</code></li>
            <li><code>refunds/create</code></li>
            <li><code>orders/cancelled</code></li>
            <li><code>customers/data_request</code></li>
            <li><code>customers/redact</code></li>
            <li><code>shop/redact</code></li>
          </ul>
        </li>
        <li>
          <strong>App Proxy:</strong> Configure Shopify App Proxy to route a storefront URL (e.g.{" "}
          <code>/apps/rewards</code>) to your app route <code>/loyalty</code>. The dashboard validates the App Proxy HMAC.
        </li>
        <li>
          <strong>Admin settings:</strong> Open the app in Shopify Admin → Apps and configure:
          earn rate, minimum order subtotal to redeem, and any customer/product tag exclusions.
        </li>
        <li>
          <strong>Expiry job:</strong> Schedule a daily POST to <code>/jobs/expire</code> with header{" "}
          <code>X-Job-Token</code> to enforce inactivity expiry.
        </li>
      </ol>

      <h2>Common issues</h2>
      <ul>
        <li>
          <strong>No points awarded:</strong> ensure the order has a customer (not guest checkout) and the customer is not
          excluded by tag (e.g. Wholesale).
        </li>
        <li>
          <strong>Duplicate points:</strong> should not happen—webhook idempotency uses webhook IDs and order snapshots.
          If it does, inspect <code>WebhookEvent</code> and the unique constraints.
        </li>
        <li>
          <strong>Customer dashboard unauthorized:</strong> App Proxy HMAC verification failed—confirm App Proxy is enabled
          and Shopify is passing <code>shop</code>, <code>logged_in_customer_id</code>, and <code>hmac</code>.
        </li>
      </ul>
    </main>
  );
}
