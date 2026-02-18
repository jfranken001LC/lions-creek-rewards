import { render, BlockStack, Text, Banner, Button } from "@shopify/ui-extensions/preact";

/**
 * Customer Accounts UI Extension
 * Target: customer-account.page.render
 *
 * IMPORTANT:
 * - Shopify's extension bundler expects a **default export**.
 */
export default render("customer-account.page.render", () => {
  return (
    <BlockStack spacing="loose">
      <Text size="large">Lions Creek Rewards</Text>

      <Banner title="Coming soon">
        Your points balance and redemption options will appear here once enabled.
      </Banner>

      <Text>
        If you’re seeing this page, the extension is installed and rendering correctly.
      </Text>

      <Button kind="secondary" onPress={() => {}}>
        Refresh
      </Button>
    </BlockStack>
  );
});
