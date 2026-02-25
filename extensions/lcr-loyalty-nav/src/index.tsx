import '@shopify/ui-extensions/preact';

import {render} from 'preact';

// Navigation is mandated: keep this target STATIC (no fetch) to avoid layout shifting.
// This renders on *all* customer account pages below the footer.

export default async () => {
  render(<FooterNav />, document.body);
};

function FooterNav() {
  return (
    <s-section>
      <s-stack direction="inline" justifyContent="space-between" alignItems="center">
        <s-text emphasis="bold">Lions Creek Rewards</s-text>
        <s-button variant="secondary" href="extension:lcr-loyalty-dashboard/">
          View rewards
        </s-button>
      </s-stack>
    </s-section>
  );
}
