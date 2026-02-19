import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

type RedemptionValueMap = Record<string, number>;

type ShopSettings = {
  earnRate: number;
  excludeProductTags: string[];
  includeProductTags: string[];
  excludedCustomerTags: string[];
  eligibleCollectionGid?: string | null;
  eligibleCollectionHandle?: string | null;
  pointsExpireInactivityDays?: number | null;
  redemptionMinOrder: number;
  redemptionExpiryHours: number;
  redemptionValueMap: RedemptionValueMap;
  maxPointsPerOrder?: number | null;
};

type LoyaltyPayload = {
  shop: string;
  customerId: string;
  balance: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  expiredAt: string | null;
  lastActivityAt: string;
  shopSettings: ShopSettings;
};

type LoyaltyResponse =
  | ({ ok: true } & LoyaltyPayload)
  | { ok: false; error: string };

type RedeemSuccess = {
  ok: true;
  code: string;
  pointsDebited: number;
  valueDollars: number;
  expiresAt: string;
};

type RedeemResponse = RedeemSuccess | { ok: false; error: string };

function getSetting(key: string): string {
  const s = (globalThis as any)?.shopify?.settings;
  const candidates = [
    s?.current?.[key],
    s?.[key],
    s?.fields?.[key],
    s?.[key]?.value,
    s?.current?.[key]?.value,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/$/, "");
}

async function getSessionToken(): Promise<string> {
  const tok = await (globalThis as any).shopify.sessionToken.get();
  return String(tok);
}

async function apiRequest<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const token = await getSessionToken();

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const json = (await res.json().catch(() => ({}))) as any;

  if (!res.ok) {
    const msg = json?.error || json?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

function formatMoney(dollars: number): string {
  return `$${Number(dollars).toFixed(2)}`;
}

function App() {
  const appBaseUrl = useMemo(() => normalizeBaseUrl(getSetting("app_base_url")), []);

  const [loading, setLoading] = useState(true);
  const [loyalty, setLoyalty] = useState<LoyaltyPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [redeeming, setRedeeming] = useState(false);
  const [redeemResult, setRedeemResult] = useState<RedeemSuccess | null>(null);

  const redemptionOptions = useMemo(() => {
    const map = loyalty?.shopSettings?.redemptionValueMap || {};
    return Object.entries(map)
      .map(([points, valueDollars]) => ({
        points: Number(points),
        valueDollars: Number(valueDollars),
      }))
      .filter((o) => Number.isFinite(o.points) && o.points > 0 && Number.isFinite(o.valueDollars) && o.valueDollars > 0)
      .sort((a, b) => a.points - b.points);
  }, [loyalty]);

  async function refresh() {
    setError(null);
    setRedeemResult(null);

    if (!appBaseUrl) {
      setLoading(false);
      setError("Extension setting missing: App base URL");
      return;
    }

    setLoading(true);
    try {
      const res = await apiRequest<LoyaltyResponse>(appBaseUrl, "/api/customer/loyalty", { method: "GET" });
      if (!("ok" in res) || !res.ok) throw new Error((res as any).error || "Failed to load loyalty");
      setLoyalty(res as any);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
      setLoyalty(null);
    } finally {
      setLoading(false);
    }
  }

  async function redeem(points: number) {
    if (!appBaseUrl) return;
    setError(null);
    setRedeeming(true);
    setRedeemResult(null);

    try {
      const res = await apiRequest<RedeemResponse>(appBaseUrl, "/api/customer/redeem", {
        method: "POST",
        body: JSON.stringify({ points }),
      });

      if (!res.ok) throw new Error(res.error || "Redemption failed");
      setRedeemResult(res);
      await refresh();
    } catch (e: any) {
      setError(e?.message || "Redemption failed");
    } finally {
      setRedeeming(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!appBaseUrl) {
    return (
      <s-page>
        <s-banner status="critical">
          <s-text>
            <s-strong>Configuration required.</s-strong> Set <s-code>App base URL</s-code> in the extension settings.
          </s-text>
        </s-banner>
      </s-page>
    );
  }

  return (
    <s-page>
      <s-stack gap="large">
        <s-stack gap="small">
          <s-heading>Rewards</s-heading>
          <s-text size="small">Connected to: {appBaseUrl}</s-text>
        </s-stack>

        {error ? (
          <s-banner status="critical">
            <s-text>{error}</s-text>
          </s-banner>
        ) : null}

        {loading ? (
          <s-banner status="info">
            <s-text>Loading your rewards…</s-text>
          </s-banner>
        ) : null}

        {loyalty ? (
          <s-card>
            <s-stack gap="small">
              <s-heading level="2">Points</s-heading>
              <s-text>
                Balance: <s-strong>{loyalty.balance}</s-strong>
              </s-text>
              <s-text size="small">Last activity: {new Date(loyalty.lastActivityAt).toLocaleString()}</s-text>
            </s-stack>
          </s-card>
        ) : null}

        {loyalty ? (
          <s-card>
            <s-stack gap="small">
              <s-heading level="2">Redeem</s-heading>

              {redemptionOptions.length === 0 ? (
                <s-text size="small">No redemption options are currently configured.</s-text>
              ) : (
                <s-stack gap="small">
                  <s-text size="small">Choose an option to generate a discount code:</s-text>
                  <s-stack gap="small">
                    {redemptionOptions.map((o) => (
                      <s-button
                        key={o.points}
                        disabled={redeeming || loyalty.balance < o.points}
                        onClick={() => redeem(o.points)}
                      >
                        Redeem {o.points} pts ({formatMoney(o.valueDollars)})
                      </s-button>
                    ))}
                  </s-stack>
                </s-stack>
              )}

              {redeemResult ? (
                <s-banner status="success">
                  <s-stack gap="xsmall">
                    <s-text>
                      Your code: <s-strong>{redeemResult.code}</s-strong>
                    </s-text>
                    <s-text size="small">Expires: {new Date(redeemResult.expiresAt).toLocaleString()}</s-text>
                  </s-stack>
                </s-banner>
              ) : null}
            </s-stack>
          </s-card>
        ) : null}

        <s-button onClick={() => refresh()} disabled={loading || redeeming}>
          Refresh
        </s-button>
      </s-stack>
    </s-page>
  );
}

render(<App />, document.body);
