import {
  render,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Divider,
  Spinner,
} from "@shopify/ui-extensions/customer-account";
import { useApi, useEffect, useMemo, useState } from "@shopify/ui-extensions/preact";

type LoyaltyBalances = {
  balance: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
};

type LoyaltySettings = {
  redemptionSteps: number[];
  dollarPerPoint: number;
  expireAfterDays: number;
};

type LedgerRow = {
  id: string;
  delta: number;
  type: string;
  description: string | null;
  createdAt: string;
};

type ActiveRedemption = {
  code: string;
  pointsDebited: number;
  valueDollars: number;
  expiresAt: string;
};

type LoyaltyResponse = {
  ok: boolean;
  balances: LoyaltyBalances;
  settings: LoyaltySettings;
  activeRedemption: ActiveRedemption | null;
  recentLedger: LedgerRow[];
};

render("customer-account.page.render", () => <App />);

function App() {
  const api = useApi();

  const baseUrl = useMemo(() => api.extension.origin, [api.extension.origin]);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<LoyaltyResponse | null>(null);
  const [redeemBusy, setRedeemBusy] = useState<number | null>(null);
  const [redeemMsg, setRedeemMsg] = useState<string | null>(null);

  async function authedFetch(path: string, init?: RequestInit) {
    const token = await api.sessionToken.get();
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  }

  async function load() {
    setLoading(true);
    setErr(null);
    setRedeemMsg(null);

    try {
      const res = await authedFetch("/api/customer/loyalty", { method: "GET" });
      const json = (await res.json()) as LoyaltyResponse;

      if (!res.ok || !json?.ok) {
        throw new Error((json as any)?.error ?? `HTTP ${res.status}`);
      }

      setData(json);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load loyalty data");
    } finally {
      setLoading(false);
    }
  }

  async function redeem(points: number) {
    setRedeemBusy(points);
    setRedeemMsg(null);
    setErr(null);

    try {
      const res = await authedFetch("/api/customer/redeem", {
        method: "POST",
        body: JSON.stringify({
          points,
          idempotencyKey: `${points}-${Date.now()}`,
        }),
      });

      const json = await res.json().catch(() => ({} as any));
      if (!res.ok || json?.ok !== true) throw new Error(json?.error ?? `HTTP ${res.status}`);

      setRedeemMsg(`Discount code: ${json.code} (expires ${new Date(json.expiry).toLocaleString()})`);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Redeem failed");
    } finally {
      setRedeemBusy(null);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <BlockStack spacing="tight">
        <InlineStack spacing="tight" blockAlignment="center">
          <Spinner />
          <Text>Loading loyalty…</Text>
        </InlineStack>
      </BlockStack>
    );
  }

  if (err) {
    return (
      <BlockStack spacing="loose">
        <Banner status="critical" title="Couldn’t load loyalty">
          <Text>{err}</Text>
        </Banner>
        <Button onPress={load}>Try again</Button>
      </BlockStack>
    );
  }

  if (!data) return <Text>No data</Text>;

  const points = data.balances?.balance ?? 0;
  const steps = (data.settings?.redemptionSteps ?? []).slice().sort((a, b) => a - b);
  const hasActive = Boolean(data.activeRedemption?.code);

  return (
    <BlockStack spacing="loose">
      <Text size="large" emphasis="bold">Lions Creek Rewards</Text>

      <Text><Text emphasis="bold">{points}</Text> points available</Text>
      <Text>Lifetime earned: {data.balances.lifetimeEarned} • Lifetime redeemed: {data.balances.lifetimeRedeemed}</Text>

      <Divider />

      {hasActive ? (
        <Banner status="warning" title="Active discount code already exists">
          <Text>Code: <Text emphasis="bold">{data.activeRedemption!.code}</Text></Text>
          <Text>Expires: {new Date(data.activeRedemption!.expiresAt).toLocaleString()}</Text>
        </Banner>
      ) : (
        <BlockStack spacing="tight">
          <Text emphasis="bold">Redeem points</Text>
          <Text>
            ~$ {data.settings.dollarPerPoint.toFixed(2)} per point • codes expire after {data.settings.expireAfterDays} days
          </Text>

          <InlineStack spacing="tight">
            {steps.map((s) => (
              <Button
                key={s}
                disabled={redeemBusy !== null || points < s}
                onPress={() => redeem(s)}
              >
                Redeem {s} pts
              </Button>
            ))}
          </InlineStack>

          {redeemMsg ? (
            <Banner status="success" title="Code created">
              <Text>{redeemMsg}</Text>
            </Banner>
          ) : null}
        </BlockStack>
      )}
    </BlockStack>
  );
}
