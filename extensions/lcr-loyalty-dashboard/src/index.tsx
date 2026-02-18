// extensions/lcr-loyalty-dashboard/src/index.tsx
// Customer Account UI Extension entrypoint.
// Shopify expects a DEFAULT export for the module referenced in shopify.extension.toml.

import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

// Shopify provides a global `shopify` object in Customer Account UI Extensions.
declare const shopify: any;

type LoyaltyPayload = {
  customerId?: string;
  shop?: string;
  pointsBalance?: number;
  tier?: string | null;
};

type RedeemResponse = {
  ok: boolean;
  message?: string;
};

const PROD_API_ORIGIN = "https://loyalty.basketbooster.ca";

// In dev, the extension bundle is typically served from your tunnel origin.
// In prod, it's typically served from a Shopify CDN origin.
// Use the bundle origin for dev; fall back to PROD_API_ORIGIN for Shopify CDN origins.
function resolveApiOrigin(): string {
  try {
    const scriptUrl = shopify?.extension?.scriptUrl;
    if (!scriptUrl) return PROD_API_ORIGIN;

    const origin = new URL(scriptUrl).origin.toLowerCase();
    const isShopifyCdn =
      origin.includes("cdn.shopify.com") ||
      origin.includes("shopifycdn.com") ||
      origin.includes("extensions.shopifycdn.com");

    return isShopifyCdn ? PROD_API_ORIGIN : new URL(scriptUrl).origin;
  } catch {
    return PROD_API_ORIGIN;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  const text = await resp.text();

  if (!resp.ok) {
    try {
      const j = JSON.parse(text);
      throw new Error(j?.error || j?.message || `${resp.status} ${resp.statusText}`);
    } catch {
      throw new Error(text || `${resp.status} ${resp.statusText}`);
    }
  }

  return text ? (JSON.parse(text) as T) : ({} as T);
}

export default async function extensionEntry() {
  // Customer Account UI extensions expect a default export that renders the UI.
  render(<Extension />, document.body);
}

function Extension() {
  const apiOrigin = useMemo(() => resolveApiOrigin(), []);
  const [loading, setLoading] = useState(true);
  const [busyRedeem, setBusyRedeem] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LoyaltyPayload | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const token = await shopify.sessionToken.get();
        const payload = await fetchJson<LoyaltyPayload>(`${apiOrigin}/api/customer/loyalty`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        });

        if (!cancelled) setData(payload);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiOrigin]);

  async function redeem100() {
    try {
      setBusyRedeem(true);
      setError(null);
      setToast(null);

      const token = await shopify.sessionToken.get();
      const resp = await fetchJson<RedeemResponse>(`${apiOrigin}/api/customer/redeem`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          pointsToRedeem: 100,
          rewardCodeType: "fixed_amount",
          rewardValue: 10,
          currency: "CAD",
        }),
      });

      setToast(resp.message || (resp.ok ? "Redeemed successfully." : "Redeem failed."));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyRedeem(false);
    }
  }

  const points = data?.pointsBalance ?? 0;

  return (
    <s-block-stack spacing="loose">
      <s-heading level="2">Lions Creek Rewards</s-heading>

      {loading ? (
        <s-text>Loading your rewards…</s-text>
      ) : error ? (
        <s-banner status="critical">
          <s-text>{error}</s-text>
        </s-banner>
      ) : (
        <>
          <s-text>
            Points balance: <s-text emphasis="strong">{points}</s-text>
          </s-text>

          <s-inline-stack spacing="tight" blockAlignment="center">
            <s-button onPress={redeem100} disabled={busyRedeem || points < 100}>
              Redeem 100 points
            </s-button>
            {busyRedeem ? <s-text appearance="subdued">Processing…</s-text> : null}
          </s-inline-stack>

          {toast ? (
            <s-banner status="success">
              <s-text>{toast}</s-text>
            </s-banner>
          ) : null}

          <s-divider />

          <s-text appearance="subdued">
            Secured using a Shopify session token.
          </s-text>
        </>
      )}
    </s-block-stack>
  );
}
