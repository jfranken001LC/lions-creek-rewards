import * as React from "react";

import {
  reactExtension,
  Banner,
  BlockStack,
  Button,
  InlineStack,
  Spinner,
  Text,
  useApi,
  useSettings,
  useSubscription,
} from "@shopify/ui-extensions-react/checkout";

type RewardsPending = {
  ok: true;
  status: "pending";
  pointsEarned: null;
  balance: null;
  nextRewardMessage: string | null;
};

type RewardsReady = {
  ok: true;
  status: "ready";
  pointsEarned: number;
  balance: number;
  nextRewardMessage: string | null;
};

type RewardsErr = { ok: false; error: string; hint?: string };

type RewardsResponse = RewardsPending | RewardsReady | RewardsErr;

export default reactExtension("purchase.thank-you.block.render", () => <Extension />);

function normalizeBaseUrl(u: string): string {
  const s = String(u || "").trim().replace(/\/+$/, "");
  return s;
}

function normalizeStorefrontUrl(u: string): string {
  return String(u || "").trim().replace(/\/+$/, "");
}

function Extension() {
  const { orderConfirmation, sessionToken, shop } = useApi();
  const settings = useSettings() as any;

  const sub: any = useSubscription(orderConfirmation);
  const orderId = sub?.id ?? sub?.order?.id ?? sub?.orderConfirmation?.order?.id ?? null;

  const appBaseUrl = normalizeBaseUrl(settings?.app_base_url || "");
  const [state, setState] = React.useState<RewardsResponse | null>(null);
  const [loading, setLoading] = React.useState<boolean>(false);

  React.useEffect(() => {
    let cancelled = false;
    let timer: any = null;

    async function runPoll() {
      if (!orderId || !appBaseUrl) return;

      setLoading(true);

      const maxAttempts = 20;
      const delayMs = 1500;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const token = await sessionToken.get();
          const url = `${appBaseUrl}/api/order/rewards?orderId=${encodeURIComponent(String(orderId))}`;
          const res = await fetch(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          });
          const data = (await res.json().catch(() => null)) as RewardsResponse | null;
          if (cancelled) return;

          if (!data) {
            setState({ ok: false, error: "Invalid response from server" });
            break;
          }

          setState(data);

          if (data.ok === true && data.status === "ready") break;

          // pending: wait and retry
          await new Promise((r) => (timer = setTimeout(r, delayMs)));
        } catch (e: any) {
          if (cancelled) return;
          setState({ ok: false, error: e?.message ?? String(e) });
          break;
        }
      }

      if (!cancelled) setLoading(false);
    }

    runPoll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderId, appBaseUrl]);

  if (!appBaseUrl) {
    return (
      <Banner status="warning">
        <Text>Rewards extension is missing its base URL configuration.</Text>
      </Banner>
    );
  }

  if (!orderId) {
    return null;
  }

  if (!state || loading || (state.ok === true && state.status === "pending")) {
    return (
      <BlockStack spacing="tight">
        <InlineStack spacing="tight" blockAlignment="center">
          <Spinner />
          <Text>Processing rewards…</Text>
        </InlineStack>
      </BlockStack>
    );
  }

  if (state.ok === false) {
    return (
      <Banner status="warning">
        <Text>Rewards: {state.error}</Text>
      </Banner>
    );
  }

  // Ready
  const pointsEarned = state.pointsEarned ?? 0;
  const balance = state.balance ?? 0;

  // Direct-link to the full-page customer account extension (customer-account.page.render)
  // via its handle. Direct linking is allowed by default for customer-account.page.render targets.
  const storefrontUrl = normalizeStorefrontUrl((shop as any)?.storefrontUrl ?? "");
  const explicitRewardsUrl = normalizeStorefrontUrl(settings?.rewards_page_url || settings?.rewardsPageUrl || "");
  const rewardsUrl = explicitRewardsUrl
    ? explicitRewardsUrl
    : storefrontUrl
      ? `${storefrontUrl}/account/lcr-loyalty-dashboard/`
      : "/account";

  return (
    <Banner status="success">
      <BlockStack spacing="tight">
        <Text>
          You earned <Text emphasis="bold">{pointsEarned}</Text> point(s). Your balance is{" "}
          <Text emphasis="bold">{balance}</Text>.
        </Text>

        {state.nextRewardMessage ? <Text>{state.nextRewardMessage}</Text> : null}

        <Button to={rewardsUrl} kind="secondary">
          View Rewards
        </Button>

        <Text size="small" appearance="subdued">
          If you don’t land on the Rewards page automatically, open My Account and tap “View rewards”.
        </Text>
      </BlockStack>
    </Banner>
  );
}
