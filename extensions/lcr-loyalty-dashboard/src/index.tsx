import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

declare const shopify: any;

// ✅ Change this if you want to point dev extension to your tunnel host
const APP_BASE_URL = "https://loyalty.basketbooster.ca";

type LoyaltyResponse = {
  ok: boolean;
  error?: string;

  shop: string;
  customerId: string;

  balances: {
    points: number;
    lifetimeEarned: number;
    lifetimeRedeemed: number;
    lastActivityAt: string | null;
    expiredAt: string | null;
  };

  settings: {
    earnRate: number;
    includeProductTags: string[];
    excludeProductTags: string[];
    excludedCustomerTags: string[];

    redemptionSteps: number[];
    redemptionValueMap: Record<string, number>;
    redemptionMinOrder: number;
    eligibleCollectionHandle: string;
    expiry: string;
  };

  activeRedemption: null | {
    id: string;
    code: string;
    points: number;
    value: number;
    status: string;
    expiresAt: string;
  };

  recentLedger: Array<{
    id: string;
    createdAt: string;
    type: string;
    delta: number;
    source: string;
    description: string;
  }>;
};

async function getSessionToken(): Promise<string> {
  if (!shopify?.sessionToken?.get) throw new Error("sessionToken API not available");
  return await shopify.sessionToken.get();
}

async function apiRequest(path: string, init: RequestInit = {}) {
  const token = await getSessionToken();
  const res = await fetch(`${APP_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

function formatDelta(n: number) {
  return `${n >= 0 ? "+" : ""}${n}`;
}

function App() {
  const [loading, setLoading] = useState(true);
  const [busyRedeem, setBusyRedeem] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LoyaltyResponse | null>(null);

  const steps = useMemo(() => data?.settings?.redemptionSteps ?? [], [data]);
  const points = data?.balances?.points ?? 0;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const d = (await apiRequest("/api/customer/loyalty", { method: "GET" })) as LoyaltyResponse;
      setData(d);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function redeem(pointsRequested: number) {
    setBusyRedeem(true);
    setError(null);
    try {
      await apiRequest("/api/customer/redeem", {
        method: "POST",
        body: JSON.stringify({ points: pointsRequested })
      });
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusyRedeem(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const active = data?.activeRedemption;

  return (
    <s-page>
      <s-section>
        <s-stack gap="tight">
          <s-heading>Lions Creek Rewards</s-heading>

          {loading && <s-text>Loading loyalty status…</s-text>}

          {error && (
            <s-banner tone="critical">
              <s-text>{error}</s-text>
            </s-banner>
          )}

          {!loading && data?.ok && (
            <>
              <s-banner tone="info">
                <s-text>
                  Points balance: <strong>{points}</strong>
                </s-text>
                <s-text>{data.settings.expiry}</s-text>
              </s-banner>

              {active ? (
                <s-banner tone="success">
                  <s-text>
                    Active reward code: <strong>{active.code}</strong>
                  </s-text>
                  <s-text>
                    {active.points} points → ${active.value} off (expires{" "}
                    {new Date(active.expiresAt).toLocaleString()})
                  </s-text>
                </s-banner>
              ) : (
                <s-banner tone="warning">
                  <s-text>No active reward code.</s-text>
                </s-banner>
              )}

              <s-divider />

              <s-heading size="medium">Redeem points</s-heading>
              <s-stack gap="tight">
                {steps.map((step) => {
                  const value = data.settings.redemptionValueMap[String(step)] ?? 0;
                  const disabled = busyRedeem || points < step || Boolean(active);
                  return (
                    <s-inline-stack key={String(step)} gap="tight" align="space-between">
                      <s-text>
                        {step} points → ${value} off
                      </s-text>
                      <s-button
                        variant="primary"
                        disabled={disabled}
                        onClick={() => redeem(step)}
                      >
                        Redeem
                      </s-button>
                    </s-inline-stack>
                  );
                })}
                {active && (
                  <s-text tone="subdued">
                    You already have an active code. Use it or wait for it to expire.
                  </s-text>
                )}
              </s-stack>

              <s-divider />

              <s-heading size="medium">Recent activity</s-heading>
              <s-stack gap="tight">
                {(data.recentLedger ?? []).slice(0, 10).map((row) => (
                  <s-inline-stack key={row.id} gap="tight" align="space-between">
                    <s-text>{new Date(row.createdAt).toLocaleDateString()}</s-text>
                    <s-text>
                      {row.type}: <strong>{formatDelta(row.delta)}</strong>
                    </s-text>
                  </s-inline-stack>
                ))}
              </s-stack>

              <s-divider />
              <s-button variant="secondary" onClick={load} disabled={loading}>
                Refresh
              </s-button>
            </>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export default async () => {
  render(<App />, document.body);
};
