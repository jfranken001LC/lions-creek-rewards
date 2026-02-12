import React, { useEffect, useMemo, useState } from "react";
import {
  reactExtension,
  BlockStack,
  InlineStack,
  Text,
  Heading,
  Button,
  TextField,
  Divider,
  Banner,
  Spinner,
  Card,
  useApi,
} from "@shopify/ui-extensions-react/customer-account";

const APP_URL = "https://loyalty.basketbooster.ca"; // must match your deployed app domain

type LoyaltyPayload = {
  ok: boolean;
  pointsBalance: number;
  pointsLifetimeEarned: number;
  pointsLifetimeRedeemed: number;
  pointsLastActivityAt: string | null;
  ledger: Array<{
    id: string;
    type: string;
    delta: number;
    description: string | null;
    createdAt: string;
  }>;
  redemptionActive: null | {
    id: string;
    code: string;
    valueCents: number;
    minimumSubtotalCents: number;
    status: string;
    expiresAt: string;
  };
  catalog: Array<{
    points: number;
    valueDollars: number;
    minimumOrderDollars: number;
  }>;
  copy: { earn: string; expiry: string };
};

export default reactExtension("customer-account.page.render", () => <App />);

function App() {
  const api = useApi();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<LoyaltyPayload | null>(null);

  const [redeemPoints, setRedeemPoints] = useState<string>("500");
  const [redeeming, setRedeeming] = useState(false);
  const [redeemMsg, setRedeemMsg] = useState<string | null>(null);

  const parsedRedeem = useMemo(() => {
    const n = Math.floor(Number(redeemPoints));
    return Number.isFinite(n) ? n : 0;
  }, [redeemPoints]);

  async function authedFetch(path: string, body?: any) {
    const token = await api.sessionToken.get();
    const resp = await fetch(`${APP_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body ?? {}),
    });

    const json = await resp.json().catch(() => null);
    if (!resp.ok || !json) {
      const msg = json?.error ?? `Request failed (${resp.status})`;
      throw new Error(msg);
    }
    return json;
  }

  async function refresh() {
    setErr(null);
    setLoading(true);
    try {
      const payload = (await authedFetch("/api/customer/loyalty")) as LoyaltyPayload;
      setData(payload);
      setRedeemMsg(null);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedCatalog = useMemo(() => {
    if (!data?.catalog?.length) return null;
    return data.catalog.find((c) => c.points === parsedRedeem) ?? null;
  }, [data, parsedRedeem]);

  async function onRedeem() {
    if (!data) return;
    setRedeeming(true);
    setRedeemMsg(null);
    setErr(null);
    try {
      const res = await authedFetch("/api/customer/redeem", { points: parsedRedeem });
      if (res?.code) {
        setRedeemMsg(`Your code: ${res.code} (expires ${new Date(res.expiresAt).toLocaleString()})`);
      } else {
        setRedeemMsg("Redemption created.");
      }
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setRedeeming(false);
    }
  }

  if (loading) {
    return (
      <BlockStack spacing="loose">
        <InlineStack spacing="loose" blockAlignment="center">
          <Spinner />
          <Text>Loading your points…</Text>
        </InlineStack>
      </BlockStack>
    );
  }

  if (err) {
    return (
      <BlockStack spacing="loose">
        <Banner title="Could not load loyalty data" status="critical">
          <Text>{err}</Text>
        </Banner>
        <Button onPress={refresh}>Try again</Button>
      </BlockStack>
    );
  }

  if (!data) return <Text>Unavailable.</Text>;

  return (
    <BlockStack spacing="loose">
      <Heading>Lions Creek Rewards</Heading>

      <Card>
        <BlockStack spacing="tight">
          <Text size="large">Points balance</Text>
          <Heading>{data.pointsBalance}</Heading>
          <Text>
            Lifetime earned: {data.pointsLifetimeEarned} • Lifetime redeemed: {data.pointsLifetimeRedeemed}
          </Text>
          <Text>
            Last activity:{" "}
            {data.pointsLastActivityAt ? new Date(data.pointsLastActivityAt).toLocaleString() : "—"}
          </Text>
        </BlockStack>
      </Card>

      <Divider />

      <Card>
        <BlockStack spacing="tight">
          <Text size="large">Rewards catalog</Text>
          {data.catalog.map((c) => (
            <Text key={c.points}>
              {c.points} points → ${c.valueDollars} off (min order ${c.minimumOrderDollars})
            </Text>
          ))}
          <Divider />
          {data.redemptionActive ? (
            <Banner title="You already have an active reward" status="info">
              <Text>
                Code: <Text emphasis="bold">{data.redemptionActive.code}</Text> • Expires{" "}
                {new Date(data.redemptionActive.expiresAt).toLocaleString()}
              </Text>
              <Text>
                Value: ${(data.redemptionActive.valueCents / 100).toFixed(2)} • Min order $
                {(data.redemptionActive.minimumSubtotalCents / 100).toFixed(2)}
              </Text>
            </Banner>
          ) : (
            <BlockStack spacing="tight">
              <TextField
                label="Redeem points"
                value={redeemPoints}
                onChange={setRedeemPoints}
                helpText="Choose 500 or 1000 points."
              />
              {selectedCatalog ? (
                <Text>
                  You’ll get ${selectedCatalog.valueDollars} off (min order ${selectedCatalog.minimumOrderDollars}).
                </Text>
              ) : (
                <Text>Please enter 500 or 1000.</Text>
              )}
              <Button
                kind="primary"
                disabled={redeeming || !selectedCatalog || data.pointsBalance < parsedRedeem}
                onPress={onRedeem}
              >
                {redeeming ? "Creating code…" : "Generate discount code"}
              </Button>
              {data.pointsBalance < parsedRedeem ? (
                <Text>Not enough points for this reward.</Text>
              ) : null}
              {redeemMsg ? (
                <Banner title="Reward created" status="success">
                  <Text>{redeemMsg}</Text>
                </Banner>
              ) : null}
            </BlockStack>
          )}
        </BlockStack>
      </Card>

      <Divider />

      <Card>
        <BlockStack spacing="tight">
          <Text size="large">How it works</Text>
          <Text>{data.copy.earn}</Text>
          <Text>{data.copy.expiry}</Text>
        </BlockStack>
      </Card>

      <Divider />

      <Card>
        <BlockStack spacing="tight">
          <Text size="large">Recent activity</Text>
          {data.ledger.length ? (
            data.ledger.slice(0, 10).map((r) => (
              <BlockStack key={r.id} spacing="extraTight">
                <InlineStack spacing="loose">
                  <Text>{new Date(r.createdAt).toLocaleDateString()}</Text>
                  <Text emphasis="bold">{r.delta > 0 ? `+${r.delta}` : `${r.delta}`}</Text>
                  <Text>{r.description ?? r.type}</Text>
                </InlineStack>
                <Divider />
              </BlockStack>
            ))
          ) : (
            <Text>No activity yet.</Text>
          )}
        </BlockStack>
      </Card>

      <Button onPress={refresh}>Refresh</Button>
    </BlockStack>
  );
}
