import { render } from "@shopify/ui-extensions/customer-account";
import { useApi, useSubscription } from "@shopify/ui-extensions-preact/customer-account";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

render("customer-account.page.render", () => <App />);

function App() {
  const api = useApi();
  const customer = useSubscription(api.customer.current);
  const customerId = customer?.id;

  const [state, setState] = useState<{
    loading: boolean;
    error?: string;
    points: number;
    lifetimePoints: number;
    tier?: string;
    wallet: Array<{ id: string; title: string; code: string; amountCents: number; status: string; expiresAt?: string }>;
  }>({
    loading: true,
    points: 0,
    lifetimePoints: 0,
    wallet: [],
  });

  const baseUrl = useMemo(() => {
    // Keep this aligned with your prod hostname.
    return "https://loyalty.basketbooster.ca";
  }, []);

  const fetchLoyalty = useCallback(async () => {
    if (!customerId) return;

    setState((s) => ({ ...s, loading: true, error: undefined }));

    try {
      const token = await api.sessionToken.get();

      const res = await fetch(`${baseUrl}/api/customer/loyalty`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const json = await res.json();

      setState({
        loading: false,
        points: json.points ?? 0,
        lifetimePoints: json.lifetimePoints ?? 0,
        tier: json.tier ?? undefined,
        wallet: Array.isArray(json.wallet) ? json.wallet : [],
      });
    } catch (e: any) {
      setState((s) => ({
        ...s,
        loading: false,
        error: e?.message ?? "Failed to load rewards.",
      }));
    }
  }, [api.sessionToken, baseUrl, customerId]);

  const redeem = useCallback(
    async (rewardId: string) => {
      try {
        const token = await api.sessionToken.get();

        const res = await fetch(`${baseUrl}/api/customer/redeem`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ rewardId }),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text}`);
        }

        await fetchLoyalty();
      } catch (e: any) {
        setState((s) => ({ ...s, error: e?.message ?? "Redeem failed." }));
      }
    },
    [api.sessionToken, baseUrl, fetchLoyalty],
  );

  useEffect(() => {
    fetchLoyalty();
  }, [fetchLoyalty]);

  return (
    <s-page title="Lions Creek Rewards">
      <s-section>
        {state.loading ? (
          <s-banner tone="info">
            <s-text>Loading your rewards…</s-text>
          </s-banner>
        ) : state.error ? (
          <s-banner tone="critical">
            <s-text>{state.error}</s-text>
          </s-banner>
        ) : (
          <s-stack gap="large">
            <s-card>
              <s-stack gap="small">
                <s-text emphasis="bold">Points balance</s-text>
                <s-text size="large">{state.points}</s-text>
                <s-text tone="subdued">Lifetime: {state.lifetimePoints}</s-text>
                {state.tier ? <s-text tone="subdued">Tier: {state.tier}</s-text> : null}
              </s-stack>
            </s-card>

            <s-card>
              <s-stack gap="small">
                <s-text emphasis="bold">Wallet</s-text>

                {state.wallet.length === 0 ? (
                  <s-text tone="subdued">No active rewards yet.</s-text>
                ) : (
                  <s-stack gap="small">
                    {state.wallet.map((w) => (
                      <s-card key={w.id}>
                        <s-stack gap="small">
                          <s-text emphasis="bold">{w.title}</s-text>
                          <s-text>Code: {w.code}</s-text>
                          <s-text tone="subdued">
                            Value: ${(w.amountCents / 100).toFixed(2)} • Status: {w.status}
                            {w.expiresAt ? ` • Expires: ${new Date(w.expiresAt).toLocaleDateString()}` : ""}
                          </s-text>
                        </s-stack>
                      </s-card>
                    ))}
                  </s-stack>
                )}
              </s-stack>
            </s-card>

            <s-card>
              <s-stack gap="small">
                <s-text emphasis="bold">Redeem</s-text>
                <s-text tone="subdued">
                  Choose a reward in the store experience and it will appear here. (If you want this page to also *list*
                  redeemable rewards, we’ll wire it to your rewards catalog endpoint.)
                </s-text>

                <s-button
                  onPress={() => redeem("sample_reward")}
                  accessibilityLabel="Redeem sample reward"
                >
                  Redeem sample reward
                </s-button>
              </s-stack>
            </s-card>

            <s-divider />

            <s-text tone="subdued">
              By using Lions Creek Rewards you agree to our{" "}
              <s-link to={`${baseUrl}/terms`}>Terms</s-link> and{" "}
              <s-link to={`${baseUrl}/privacy`}>Privacy Policy</s-link>.
            </s-text>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
