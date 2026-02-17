/* eslint-disable react-hooks/exhaustive-deps */
import {
  reactExtension,
  useApi,
  useExtensionCapability,
  useSessionToken,
  BlockStack,
  Card,
  Text,
  Button,
  InlineStack,
  Divider,
  Banner,
  Spinner,
} from "@shopify/ui-extensions-react/customer-account";
import { useEffect, useMemo, useState } from "react";

const APP_BASE_URL = "https://loyalty.basketbooster.ca";

type LoyaltySnapshot =
  | {
      ok: true;
      customerId: string;
      customerName?: string | null;
      pointsBalance: number;
      tier?: string | null;
      lastEarnedAt?: string | null;
      lastEarnedSource?: string | null;
    }
  | { ok: false; error: string };

type RedeemResponse =
  | {
      ok: true;
      discountCode: string;
      redemptionId: string;
      pointsDebited: number;
      expiresAt: string;
    }
  | { ok: false; error: string };

export default reactExtension("customer-account.page.render", () => (
  <LoyaltyDashboard />
));

function LoyaltyDashboard() {
  const api = useApi();
  const sessionToken = useSessionToken();
  const canNetwork = useExtensionCapability("network_access");

  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<LoyaltySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [redeeming, setRedeeming] = useState(false);
  const [redeemResult, setRedeemResult] = useState<RedeemResponse | null>(null);

  const canCallApi = useMemo(() => {
    return canNetwork === true;
  }, [canNetwork]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!canCallApi) {
        setError("This extension does not have network access enabled.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      setRedeemResult(null);

      try {
        // CHANGED: use POST (server supports GET+POST; requirements specify POST)
        const snap = await apiRequest<LoyaltySnapshot>(
          sessionToken,
          "/api/customer/loyalty",
          { method: "POST" }
        );

        if (cancelled) return;

        setSnapshot(snap);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error)?.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [canCallApi, sessionToken]);

  async function onRedeem() {
    if (!canCallApi) return;

    setRedeeming(true);
    setRedeemResult(null);
    setError(null);

    try {
      const res = await apiRequest<RedeemResponse>(
        sessionToken,
        "/api/customer/redeem",
        { method: "POST" }
      );

      setRedeemResult(res);

      // Refresh snapshot after redeem
      const snap = await apiRequest<LoyaltySnapshot>(
        sessionToken,
        "/api/customer/loyalty",
        { method: "POST" }
      );
      setSnapshot(snap);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setRedeeming(false);
    }
  }

  return (
    <BlockStack spacing="loose">
      <Text size="large" emphasis="bold">
        Lions Creek Rewards
      </Text>

      {!canCallApi ? (
        <Banner status="critical">
          Network access is disabled for this extension. Enable
          <Text emphasis="bold"> network_access </Text>
          in <Text emphasis="bold">shopify.extension.toml</Text>.
        </Banner>
      ) : null}

      {loading ? (
        <InlineStack spacing="loose" inlineAlignment="center">
          <Spinner />
          <Text>Loading your loyalty summary…</Text>
        </InlineStack>
      ) : null}

      {error ? <Banner status="critical">{error}</Banner> : null}

      {!loading && snapshot?.ok === false ? (
        <Banner status="critical">
          Could not load loyalty: {snapshot.error}
        </Banner>
      ) : null}

      {!loading && snapshot?.ok === true ? (
        <Card>
          <BlockStack spacing="tight">
            <Text emphasis="bold">
              {snapshot.customerName ? `Hi ${snapshot.customerName}!` : "Hi!"}
            </Text>

            <Text>
              <Text emphasis="bold">{snapshot.pointsBalance}</Text> points
              available
            </Text>

            {snapshot.tier ? <Text>Tier: {snapshot.tier}</Text> : null}

            {snapshot.lastEarnedAt ? (
              <Text>
                Last earned: {new Date(snapshot.lastEarnedAt).toLocaleString()}
                {snapshot.lastEarnedSource
                  ? ` (${snapshot.lastEarnedSource})`
                  : ""}
              </Text>
            ) : null}

            <Divider />

            <InlineStack spacing="base" inlineAlignment="start">
              <Button onPress={onRedeem} disabled={redeeming}>
                Redeem points
              </Button>

              {redeeming ? (
                <InlineStack spacing="tight" inlineAlignment="center">
                  <Spinner />
                  <Text>Creating code…</Text>
                </InlineStack>
              ) : null}
            </InlineStack>

            {redeemResult?.ok === false ? (
              <Banner status="critical">
                Redeem failed: {redeemResult.error}
              </Banner>
            ) : null}

            {redeemResult?.ok === true ? (
              <Banner status="success">
                Your discount code:
                <Text emphasis="bold"> {redeemResult.discountCode}</Text>
                <Text>
                  Expires: {new Date(redeemResult.expiresAt).toLocaleString()}
                </Text>
              </Banner>
            ) : null}
          </BlockStack>
        </Card>
      ) : null}

      <Text size="small" appearance="subdued">
        If you need help, contact support from the Lions Creek Team.
      </Text>
    </BlockStack>
  );
}

async function apiRequest<T>(
  sessionToken: ReturnType<typeof useSessionToken>,
  path: string,
  init?: RequestInit
): Promise<T> {
  const token = await sessionToken.get();

  const res = await fetch(`${APP_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let data: unknown = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON response
  }

  if (!res.ok) {
    const msg =
      (data as any)?.error ||
      (data as any)?.message ||
      `Request failed (${res.status})`;
    throw new Error(msg);
  }

  return data as T;
}
