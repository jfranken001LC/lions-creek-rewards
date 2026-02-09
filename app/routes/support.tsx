export default function Support() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>Basket Booster Discounts — Support</h1>

      <p>
        For support, please email{" "}
        <a href="mailto:Support@TwoMenOnAYellowCouch.com">Support@TwoMenOnAYellowCouch.com</a>.
      </p>

      <h2>How it works</h2>
      <p>
        This app applies a fixed amount off the order subtotal for every <strong>N</strong> Bottle Equivalents (BE) found
        in the cart.
      </p>

      <h2>Setup checklist</h2>
      <ol>
        <li>
          In Shopify Admin, ensure you have a product metafield definition:
          <strong> loyalty.bottle_equivalent</strong> (Integer).
        </li>
        <li>
          Set BE values on products (or variants). Recommended mapping for a 250ml base:
          <strong> 250ml=1</strong>, <strong>500ml=2</strong>, <strong>2L=4</strong>.
        </li>
        <li>
          Create a discount and choose the app function:
          <strong> Bottle Equivalent Discount Function</strong>.
        </li>
        <li>
          Configure Trigger BE, Amount per trigger, and (optionally) a maximum discount cap. Save and test in checkout.
        </li>
      </ol>

      <h2>Common issues</h2>
      <ul>
        <li>
          If no discount applies, confirm the product metafield has a numeric BE value and your trigger threshold is met.
        </li>
      </ul>
    </main>
  );
}
