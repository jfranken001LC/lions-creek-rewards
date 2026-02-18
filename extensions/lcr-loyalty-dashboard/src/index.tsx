/** @jsxImportSource preact */
// extensions/lcr-loyalty-dashboard/src/index.tsx

import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

declare const shopify: any;

type LoyaltyPayload = {
  customerId: string;
  balances: {
    balance: number;
    lifetimeEarned: number;
    lifetimeRedeemed: number;
    lastActivityAt: string | null;
    expiredAt: string | null;
  };
  settings: {
    pointsPerDollar: number;
    redemptionSteps: number[];
    redemptionValueMap: Record<string, number>;
    redemptionMinOrderCents: number;
    eligibleCollectionHandle: string;
    pointsExpireInactivityDays: number;
    redemptionExpiryHours: number;
  };
  activeRedemption: null | {
    id: string;
    code: string;
    valueDollars: number;
    points: number;
    expiresAt: string;
    status: string;
  };
  ledger: Array<{
    id: string;
    createdAt: string;
    type: string;
    delta: number;
    description: string | null;
  }>;
};

type LoyaltyResponse = {
  ok: boolean;
  payload?: LoyaltyPayload;
  error?: string;
};

type RedeemResponse =
  | { ok: true; redemption: { code: string; valueDollars: number; points: number; expiresAt: string } }
  | { ok: false; error: string };

export default async function extension() {
  render(<App />, document.body);
}

function App() {
  // IMPORTANT: In production, Shopify hosts extension assets on Shopify’s CDN.
  // Do NOT rely on import.meta.url for your app origin.
  // Keep this aligned with SHOPIFY_APP_URL (your app’s public URL).
  const baseUrl = useMemo(() => "https://loyalty.basketbooster.ca", []);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<LoyaltyPayload | null>(null);
  const [redeemingPoints, setRedeemingPoints] = useState<number | null>(null);

  const fetchLoyalty = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const token = await shopify.sessionToken.get();

      const res = await fetch(`${baseUrl}/api/customer/loyalty`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      const json = (await res.json()) as LoyaltyResponse;

      if (!res.ok || !json.ok || !json.payload) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }

      setPayload(json.payload);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load rewards.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  const redeem = useCallback(
    async (points: number) => {
      setRedeemingPoints(points);
      setError(null);

      try {
        const token = await shopify.sessionToken.get();
        const idemKey =
          typeof crypto !== "undefined" && "randomUUID" in crypto ? (crypto as any).randomUUID() : String(Date.now());

        const res = await fetch(`${baseUrl}/api/customer/redeem`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ points, idemKey }),
        });

        const json = (await res.json()) as RedeemResponse;

        if (!res.ok || !json.ok) {
          throw new Error((json as any).error || `HTTP ${res.status}`);
        }

        // Refresh view (shows active redemption + updated balance)
        await fetchLoyalty();
      } catch (e: any) {
        setError(e?.message ?? "Redeem failed.");
      } finally {
        setRedeemingPoints(null);
      }
    },
    [baseUrl, fetchLoyalty]
  );

  useEffect(() => {
    fetchLoyalty();
  }, [fetchLoyalty]);

  if (loading) {
    return (
      <s-page title="Lions Creek Rewards">
        <s-section>
          <s-banner tone="info">
            <s-text>Loading your rewards…</s-text>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  if (error) {
    return (
      <s-page title="Lions Creek Rewards">
        <s-section>
          <s-banner tone="critical">
            <s-text>{error}</s-text>
          </s-banner>
          <s-spacer size="base" />
          <s-button onPress={fetchLoyalty}>Try again</s-button>
        </s-section>
      </s-page>
    );
  }

  if (!payload) {
    return (
      <s-page title="Lions Creek Rewards">
        <s-section>
          <s-banner tone="critical">
            <s-text>Unable to load your rewards right now.</s-text>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  const { balances, settings, activeRedemption, ledger } = payload;
  const minOrder = settings.redemptionMinOrderCents > 0 ? `$${(settings.redemptionMinOrderCents / 100).toFixed(2)}` : null;

  return (
    <s-page title="Lions Creek Rewards">
      <s-section>
        <s-stack gap="large">
          <s-card>
            <s-stack gap="small">
              <s-text emphasis="bold">Points balance</s-text>
              <s-text size="large">{balances.balance}</s-text>
              <s-text tone="subdued">
                Lifetime earned: {balances.lifetimeEarned} • Lifetime redeemed: {balances.lifetimeRedeemed}
              </s-text>
            </s-stack>
          </s-card>

          {activeRedemption ? (
            <s-card>
              <s-stack gap="small">
                <s-text emphasis="bold">Active reward</s-text>
                <s-text size="large">Code: {activeRedemption.code}</s-text>
                <s-text tone="subdued">
                  Value: ${activeRedemption.valueDollars.toFixed(2)} • Cost: {activeRedemption.points} points
                </s-text>
                <s-text tone="subdued">
                  Expires: {new Date(activeRedemption.expiresAt).toLocaleString()}
                </s-text>
              </s-stack>
            </s-card>
          ) : (
            <s-card>
              <s-stack gap="small">
                <s-text emphasis="bold">Redeem points</s-text>
                <s-text tone="subdued">
                  Choose a redemption amount. Your reward code will expire after {settings.redemptionExpiryHours} hours.
                  {minOrder ? ` Minimum order: ${minOrder}.` : ""}
                </s-text>

                <s-stack gap="small">
                  {settings.redemptionSteps.map((p) => {
                    const dollars = settings.redemptionValueMap[String(p)];
                    const disabled = redeemingPoints !== null || balances.balance < p;
                    return (
                      <s-button
                        key={p}
                        disabled={disabled}
                        onPress={() => redeem(p)}
                        accessibilityLabel={`Redeem ${p} points`}
                      >
                        {redeemingPoints === p ? "Redeeming…" : `Redeem ${p} points → $${(dollars ?? 0).toFixed(2)}`}
                      </s-button>
                    );
                  })}
                </s-stack>

                {balances.balance < Math.min(...settings.redemptionSteps) ? (
                  <s-banner tone="warning">
                    <s-text>
                      You need at least {Math.min(...settings.redemptionSteps)} points to redeem.
                    </s-text>
                  </s-banner>
                ) : null}
              </s-stack>
            </s-card>
          )}

          <s-card>
            <s-stack gap="small">
              <s-text emphasis="bold">Recent activity</s-text>
              {ledger.length === 0 ? (
                <s-text tone="subdued">No activity yet.</s-text>
              ) : (
                <s-stack gap="small">
                  {ledger.slice(0, 10).map((e) => (
                    <s-card key={e.id}>
                      <s-stack gap="extraTight">
                        <s-text emphasis="bold">
                          {e.type} {e.delta > 0 ? `+${e.delta}` : e.delta}
                        </s-text>
                        <s-text tone="subdued">{new Date(e.createdAt).toLocaleString()}</s-text>
                        {e.description ? <s-text tone="subdued">{e.description}</s-text> : null}
                      </s-stack>
                    </s-card>
                  ))}
                </s-stack>
              )}
            </s-stack>
          </s-card>

          <s-divider />

          <s-text tone="subdued">
            By using Lions Creek Rewards you agree to our{" "}
            <s-link to={`${baseUrl}/terms`}>Terms</s-link> and{" "}
            <s-link to={`${baseUrl}/privacy`}>Privacy Policy</s-link>.
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}
