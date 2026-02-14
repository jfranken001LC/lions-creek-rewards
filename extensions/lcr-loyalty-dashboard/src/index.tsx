// extensions/lcr-loyalty-dashboard/src/index.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  reactExtension,
  BlockStack,
  InlineStack,
  Text,
  Heading,
  Button,
  Divider,
  Banner,
  Spinner,
  Card,
  TextField,
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

type RedeemResponse = {
  ok: boolean;
  redemptionId?: string;
  code?: string;
  expiresAt?: string;
  points?: number;
  valueDollars?: number;
  discountNodeId?: string;
  error?: string;
};

export default reactExtension("customer-account.page.render", () => <App />);

function App() {
  const api = useApi();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<LoyaltyPayload | null>(null);

  const [redeemPoints, setRedeemPoints] = useState<string>(""); // will default from catalog
  const [redeeming, setRedeeming] = useState(false);
  const [redeemMsg, setRedeemMsg] = useState<string | null>(null);

  const parsedRedeem = useMemo(() => {
    const n = Math.floor(Number(redeemPoints));
    return Number.isFinite(n) ? n : 0;
  }, [redeemPoints]);

  function fmtMoney(n: number) {
    // keep it simple and deterministic
    return `$${Number(n || 0).toFixed(2)}`;
  }

  async function authedPost<T = any>(path: string, body?: any): Promise<T> {
    const token = await api.sessionToken.get();

    const resp = await fetch(`${APP_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body ?? {}),
    });

    const jsonBody = (await resp.json().catch(() => null)) as any;

    // Handle non-2xx
    if (!resp.ok || !jsonBody) {
      const msg = jsonBody?.error ?? `Request failed (${resp.status})`;
      throw new Error(msg);
    }

    // Defensive: treat {ok:false} as an error even if HTTP 200
    if (jsonBody?.ok === false) {
      const msg = jsonBody?.error ?? "Request failed";
      throw new Error(msg);
    }

    return jsonBody as T;
  }

  async function refresh() {
    setErr(null);
    setLoading(true);

    try {
      const payload = await authedPost<LoyaltyPayload>("/api/customer/loyalty");

      setData(payload);
      setRedeemMsg(null);

      // Ensure we always have a valid selected step
      const steps = (payload.catalog ?? []).map((c) => c.points).filter((p) => Number.isFinite(p) && p > 0);
      if (steps.length) {
        const current = Math.floor(Number(redeemPoints));
        if (!steps.includes(current)) {
          setRedeemPoints(String(steps[0]));
        }
      } else if (!redeemPoints) {
        setRedeemPoints("500");
      }
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
      const res = await authedPost<RedeemResponse>("/api/customer/redeem", { points: parsedRedeem });

      if (res?.code && res?.expiresAt) {
        setRedeemMsg(`Your code: ${res.code} (expires ${new Date(res.expiresAt).toLocaleString()})`);
      } else {
        setRedeemMsg("Reward created.");
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

  const active = data.redemptionActive;

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
            Last activity: {data.pointsLastActivityAt ? new Date(data.pointsLastActivityAt).toLocaleString() : "—"}
          </Text>
        </BlockStack>
      </Card>

      <Divider />

      <Card>
        <BlockStack spacing="tight">
          <Text size="large">Rewards</Text>

          {data.catalog?.length ? (
            <BlockStack spacing="extraTight">
              {data.catalog.map((c) => (
                <Text key={c.points}>
                  {c.points} points → {fmtMoney(c.valueDollars)} off (min order {fmtMoney(c.minimumOrderDollars)})
                </Text>
              ))}
            </BlockStack>
          ) : (
            <Text>Rewards are not available right now.</Text>
          )}

          <Divider />

          {active ? (
            <Banner title="You already have an active reward code" status="info">
              <Text>
                Code: <Text emphasis="bold">{active.code}</Text> • Expires{" "}
                {new Date(active.expiresAt).toLocaleString()}
              </Text>
              <Text>
                Value: {fmtMoney(active.valueCents / 100)} • Min order {fmtMoney(active.minimumSubtotalCents / 100)}
              </Text>
              <Text>Use this code at checkout before it expires.</Text>
            </Banner>
          ) : (
            <BlockStack spacing="tight">
              <TextField
                label="Redeem points"
                value={redeemPoints}
                onChange={setRedeemPoints}
                helpText={data.catalog?.length ? "Choose one of the point values shown above." : "Enter points to redeem."}
              />

              {selectedCatalog ? (
                <Text>
                  You’ll get {fmtMoney(selectedCatalog.valueDollars)} off (min order{" "}
                  {fmtMoney(selectedCatalog.minimumOrderDollars)}).
                </Text>
              ) : (
                <Text>Enter a valid points amount from the Rewards list.</Text>
              )}

              <Button
                kind="primary"
                disabled={
                  redeeming ||
                  !selectedCatalog ||
                  data.pointsBalance < parsedRedeem ||
                  parsedRedeem <= 0 ||
                  !data.catalog?.length
                }
                onPress={onRedeem}
              >
                {redeeming ? "Creating code…" : "Generate discount code"}
              </Button>

              {data.pointsBalance < parsedRedeem && parsedRedeem > 0 ? <Text>Not enough points for this reward.</Text> : null}

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
          <Text>{data.copy?.earn ?? "Earn points on eligible purchases."}</Text>
          <Text>{data.copy?.expiry ?? "Points may expire after inactivity."}</Text>
        </BlockStack>
      </Card>

      <Divider />

      <Card>
        <BlockStack spacing="tight">
          <Text size="large">Recent activity</Text>
          {data.ledger?.length ? (
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
