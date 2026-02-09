export default function Privacy() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>Basket Booster Discounts — Privacy Policy</h1>

      <p>
        Basket Booster Discounts is provided by Two Men On A Yellow Couch Software. This app is designed to apply order
        discounts based on Bottle Equivalent (BE) metafields set on products or variants in a Shopify store.
      </p>

      <h2>Data collection</h2>
      <p>
        This app does not store customer personal information in an external database. The discount calculation runs in
        Shopify’s checkout environment using Shopify Functions.
      </p>

      <h2>Webhooks &amp; compliance</h2>
      <p>
        To comply with Shopify’s platform requirements, the app supports Shopify’s required privacy webhooks:
        customers/data_request, customers/redact, and shop/redact.
      </p>

      <h2>Contact</h2>
      <p>
        If you have questions about this policy, contact{" "}
        <a href="mailto:Support@TwoMenOnAYellowCouch.com">Support@TwoMenOnAYellowCouch.com</a>.
      </p>
    </main>
  );
}
