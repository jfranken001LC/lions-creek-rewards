import {
  extension,
  Banner,
  BlockStack,
  Button,
  TextBlock,
} from "@shopify/ui-extensions/customer-account";

/**
 * Customer Accounts UI Extension
 * Target: customer-account.page.render
 *
 * IMPORTANT:
 * - Shopify's extension bundler expects a **default export**.
 * - You should NOT call `shopify.extend(...)` yourself here.
 */
export default extension("customer-account.page.render", (root) => {
  const content = root.createComponent(BlockStack, { spacing: "loose" }, [
    root.createComponent(TextBlock, undefined, "Lions Creek Rewards"),
    root.createComponent(
      Banner,
      { title: "Coming soon" },
      "Your points balance and redemption options will appear here once enabled.",
    ),
    root.createComponent(
      TextBlock,
      undefined,
      "If you’re seeing this page, the extension is installed and rendering correctly.",
    ),
    root.createComponent(Button, { kind: "secondary" }, "Refresh"),
  ]);

  root.appendChild(content);
});
