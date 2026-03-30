import '@shopify/ui-extensions/preact';

import {render} from 'preact';
import {useEffect, useMemo, useState} from 'preact/hooks';

declare const shopify: any;
declare const process: { env?: Record<string, string | undefined> };

type TierMetricType = 'lifetimeEarned' | 'lifetimeEligibleSpend';
type RedemptionStatus = 'ISSUED' | 'APPLIED' | 'EXPIRED' | 'CANCELED';

type LoyaltyPayloadOk = {
  ok: true;
  shop: string;
  customerId: string;
  points: {
    balance: number;
    lifetimeEarned: number;
    lifetimeRedeemed: number;
    lifetimeEligibleSpend: number;
    lastActivityAt: string | null;
    expireAfterDays: number | null;
  };
  tier: {
    currentTierId: string;
    currentTierName: string;
    effectiveEarnRate: number;
    nextTierName: string | null;
    remainingToNext: number;
    remainingMetricType: TierMetricType;
    currentMetric: number;
    currentMetricType: TierMetricType;
    tierComputedAt: string | null;
  };
  redemption:
    | {
        id: string;
        code: string;
        pointsRedeemed: number;
        discountAmount: number;
        status: RedemptionStatus;
        expiresAt: string;
        createdAt: string;
      }
    | null;
  redemptionOptions: Array<{
    points: number;
    valueDollars: number;
    canRedeem: boolean;
  }>;
  recentActivity: Array<{
    id: string;
    type: string;
    delta: number;
    description: string | null;
    createdAt: string;
  }>;
  settings: {
    earnRate: number;
    baseEarnRate: number;
    minOrderDollars: number;
    redemptionExpiryHours: number;
    preventMultipleActiveRedemptions: boolean;
    redemptionSteps: number[];
    redemptionValueMap: Record<string, number>;
    tiers: Array<{
      tierId: string;
      name: string;
      thresholdType: TierMetricType;
      thresholdValue: number;
      earnRateMultiplier: number;
      pointsPerDollarOverride: number | null;
    }>;
  };
};

type LoyaltyPayloadErr = {
  ok: false;
  error: string;
  details?: unknown;
};

type RedeemResponseOk = {
  ok: true;
  code: string;
  expiresAt: string;
  pointsRedeemed: number;
  discountAmount: number;
  newBalance: number;
};

type RedeemResponseErr = {
  ok: false;
  error: string;
  details?: unknown;
};

export default async () => {
  render(<Extension />, document.body);
};



function getResolvedAppBaseUrl(): string {
  return getInjectedAppBaseUrl() || getAppBaseUrlFromSettings();
}

function Extension() {
  const [appBaseUrl, setAppBaseUrl] = useState<string>(() => getResolvedAppBaseUrl());
  const [loading, setLoading] = useState<boolean>(true);
  const [payload, setPayload] = useState<LoyaltyPayloadOk | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedPoints, setSelectedPoints] = useState<number | null>(null);
  const [redeeming, setRedeeming] = useState<boolean>(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    const signal = shopify?.settings;
    if (signal && typeof signal.subscribe === 'function') {
      return signal.subscribe((next: any) => {
        const nextBase = getInjectedAppBaseUrl() || normalizeBaseUrl(String(next?.app_base_url ?? next?.appBaseUrl ?? next?.baseUrl ?? ""));
        setAppBaseUrl(nextBase);
      });
    }
    return undefined;
  }, []);

  const redemptionOptions = useMemo(() => {
    if (!payload) return [];
    if (Array.isArray(payload.redemptionOptions) && payload.redemptionOptions.length) {
      return payload.redemptionOptions
        .map((o) => ({
          points: Number(o.points),
          dollars: Number(o.valueDollars),
          canRedeem: Boolean(o.canRedeem),
          label: `${formatNumber(o.points)} points → ${formatCurrency(o.valueDollars)} off`,
        }))
        .filter((o) => o.points > 0 && o.dollars > 0)
        .sort((a, b) => a.points - b.points);
    }

    const steps = Array.isArray(payload.settings.redemptionSteps) ? payload.settings.redemptionSteps : [];
    const map = payload.settings.redemptionValueMap ?? {};
    return steps
      .map((points) => ({
        points,
        dollars: Number(map[String(points)] ?? 0),
        canRedeem: true,
        label: `${formatNumber(points)} points → ${formatCurrency(Number(map[String(points)] ?? 0))} off`,
      }))
      .filter((o) => o.points > 0 && o.dollars > 0)
      .sort((a, b) => a.points - b.points);
  }, [payload]);

  useEffect(() => {
    if (!redemptionOptions.length) {
      setSelectedPoints(null);
      return;
    }
    setSelectedPoints((prev) => {
      if (prev && redemptionOptions.some((o) => o.points === prev)) return prev;
      return redemptionOptions[0].points;
    });
  }, [redemptionOptions]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      setSuccessMessage(null);

      if (!appBaseUrl) {
        setLoading(false);
        setPayload(null);
        setError(null);
        return;
      }

      try {
        const result = await fetchLoyalty(appBaseUrl);
        if (cancelled) return;

        if (!result.ok) {
          setPayload(null);
          setError(result.error || 'Unable to load loyalty data.');
          setLoading(false);
          return;
        }

        setPayload(result);
        setLoading(false);
      } catch (e: any) {
        if (cancelled) return;
        setPayload(null);
        setError(e?.message ?? 'Unexpected error loading loyalty data.');
        setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [appBaseUrl]);

  async function onRedeem() {
    if (!payload || !appBaseUrl || !selectedPoints) return;

    setRedeeming(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const resp = await redeemPoints(appBaseUrl, selectedPoints);
      if (!resp.ok) {
        setError(resp.error || 'Unable to redeem points.');
        setRedeeming(false);
        return;
      }

      setPayload((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          points: {
            ...prev.points,
            balance: resp.newBalance,
          },
          redemption: {
            id: prev.redemption?.id ?? 'active',
            code: resp.code,
            pointsRedeemed: resp.pointsRedeemed,
            discountAmount: resp.discountAmount,
            status: 'ISSUED',
            expiresAt: resp.expiresAt,
            createdAt: prev.redemption?.createdAt ?? new Date().toISOString(),
          },
        };
      });

      setSuccessMessage('Discount code created. Use it at checkout to redeem your reward.');
    } catch (e: any) {
      setError(e?.message ?? 'Unexpected error redeeming points.');
    } finally {
      setRedeeming(false);
    }
  }

  const available = payload?.points?.balance ?? 0;
  const usesSpendTiers = Boolean(payload?.settings?.tiers?.some((tier) => tier.thresholdType === 'lifetimeEligibleSpend'));

  return (
    <s-page heading="Lions Creek Rewards" subheading="Earn points on every order. Redeem points for discounts.">
      {!appBaseUrl ? (
        <s-banner tone="info" heading="Rewards are temporarily unavailable">
          <s-stack direction="block" gap="base">
            <s-text>We could not load your rewards details right now.</s-text>
            <s-text type="small">Please refresh this page in a moment. If the problem continues, contact the store.</s-text>
          </s-stack>
        </s-banner>
      ) : null}

      {error ? (
        <s-banner tone="critical" heading="Something went wrong">
          <s-text>{error}</s-text>
        </s-banner>
      ) : null}

      {successMessage ? (
        <s-banner tone="success" heading="Success">
          <s-text>{successMessage}</s-text>
        </s-banner>
      ) : null}

      {loading ? (
        <s-section heading="Loading">
          <s-stack direction="block" gap="base">
            <s-spinner />
            <s-text type="small">Fetching your points…</s-text>
          </s-stack>
        </s-section>
      ) : null}

      {!loading && payload ? (
        <>
          <s-section heading="Your points">
            <s-stack direction="block" gap="base">
              <s-text>
                Available points: <s-badge tone="info">{formatNumber(available)}</s-badge>
              </s-text>
              <s-text>
                Tier: <s-badge tone="success">{payload.tier.currentTierName}</s-badge>
              </s-text>
              <s-text type="small">
                Earn rate: {formatNumber(payload.tier.effectiveEarnRate)} point(s) per {formatCurrency(1)} spent
              </s-text>
              {payload.tier.nextTierName ? (
                <s-text type="small">{formatTierProgress(payload.tier.remainingToNext, payload.tier.remainingMetricType, payload.tier.nextTierName)}</s-text>
              ) : (
                <s-text type="small">You are at the highest available tier.</s-text>
              )}

              <s-text type="small">
                Lifetime earned: {formatNumber(payload.points.lifetimeEarned)} · Lifetime redeemed:{' '}
                {formatNumber(payload.points.lifetimeRedeemed)}
              </s-text>

              {usesSpendTiers ? (
                <s-text type="small">Lifetime eligible spend: {formatCurrency(payload.points.lifetimeEligibleSpend)}</s-text>
              ) : null}

              {payload.points.expireAfterDays ? (
                <s-text type="small">
                  Points expire after {formatNumber(payload.points.expireAfterDays)} days of inactivity.
                </s-text>
              ) : null}

              {payload.points.lastActivityAt ? (
                <s-text type="small">Last activity: {formatDate(payload.points.lastActivityAt)}</s-text>
              ) : null}
            </s-stack>
          </s-section>

          <s-section heading="Redeem points">
            <s-stack direction="block" gap="base">
              {payload.redemption && payload.redemption.status === 'ISSUED' ? (
                <s-banner tone="info" heading="Active discount code">
                  <s-stack direction="block" gap="base">
                    <s-text>
                      Code: <s-badge tone="success">{payload.redemption.code}</s-badge>
                    </s-text>
                    <s-text type="small">
                      Value: {formatCurrency(payload.redemption.discountAmount)} off · Points used:{' '}
                      {formatNumber(payload.redemption.pointsRedeemed)}
                    </s-text>
                    <s-text type="small">Expires: {formatDate(payload.redemption.expiresAt)}</s-text>
                  </s-stack>
                </s-banner>
              ) : null}

              {!redemptionOptions.length ? (
                <s-text type="small">No redemption options are available right now.</s-text>
              ) : (
                <>
                  <s-select
                    label="Choose a reward"
                    value={selectedPoints ? String(selectedPoints) : undefined}
                    onChange={(e: any) => setSelectedPoints(Number(e?.target?.value))}
                  >
                    {redemptionOptions.map((opt) => (
                      <s-option key={String(opt.points)} value={String(opt.points)}>
                        {opt.label}
                      </s-option>
                    ))}
                  </s-select>

                  <s-button
                    variant="primary"
                    disabled={redeeming || !selectedPoints || !redemptionOptions.find((o) => o.points === selectedPoints)?.canRedeem}
                    loading={redeeming}
                    onClick={onRedeem}
                  >
                    Redeem
                  </s-button>

                  {selectedPoints
                    ? (() => {
                        const opt = redemptionOptions.find((o) => o.points === selectedPoints) || null;
                        if (!opt) return null;
                        if (opt.canRedeem) return null;
                        const hasActive = Boolean(payload.redemption && payload.redemption.status === 'ISSUED');
                        if (hasActive && payload.settings.preventMultipleActiveRedemptions) {
                          return <s-text type="small">You already have an active discount code. Use it at checkout before redeeming again.</s-text>;
                        }
                        if (opt.points > available) {
                          return <s-text type="small">You don’t have enough points for that reward.</s-text>;
                        }
                        return <s-text type="small">This reward is not currently available.</s-text>;
                      })()
                    : null}

                  <s-text type="small">
                    Base earn rate: {formatNumber(payload.settings.baseEarnRate)} point(s) per {formatCurrency(1)} spent · Minimum
                    order: {formatCurrency(payload.settings.minOrderDollars)}
                  </s-text>
                </>
              )}
            </s-stack>
          </s-section>

          {Array.isArray(payload.recentActivity) && payload.recentActivity.length ? (
            <s-section heading="Recent activity">
              <s-stack direction="block" gap="base">
                {payload.recentActivity.slice(0, 5).map((a) => (
                  <s-stack key={a.id} direction="block" gap="tight">
                    <s-text>
                      {a.delta >= 0 ? '+' : ''}
                      {formatNumber(a.delta)} ({a.type})
                    </s-text>
                    <s-text type="small">
                      {a.description ? a.description : ''}
                      {a.description ? ' · ' : ''}
                      {formatDate(a.createdAt)}
                    </s-text>
                  </s-stack>
                ))}
              </s-stack>
            </s-section>
          ) : null}
        </>
      ) : null}
    </s-page>
  );
}

async function fetchLoyalty(appBaseUrl: string): Promise<LoyaltyPayloadOk | LoyaltyPayloadErr> {
  const token = await shopify.sessionToken.get();
  const url = `${normalizeBaseUrl(appBaseUrl)}/api/customer/loyalty`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  const body = (await safeJson(res)) as any;

  if (!res.ok) {
    return {
      ok: false,
      error: body?.error ?? `HTTP ${res.status}`,
      details: body,
    };
  }

  return body as LoyaltyPayloadOk;
}

async function redeemPoints(appBaseUrl: string, pointsToRedeem: number): Promise<RedeemResponseOk | RedeemResponseErr> {
  const token = await shopify.sessionToken.get();
  const url = `${normalizeBaseUrl(appBaseUrl)}/api/customer/redeem`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({pointsToRedeem}),
  });

  const body = (await safeJson(res)) as any;

  if (!res.ok) {
    return {
      ok: false,
      error: body?.error ?? `HTTP ${res.status}`,
      details: body,
    };
  }

  return body as RedeemResponseOk;
}

function getInjectedAppBaseUrl(): string {
  try {
    return normalizeBaseUrl(String(process?.env?.APP_URL ?? ""));
  } catch {
    return "";
  }
}

function getAppBaseUrlFromSettings(): string {
  const signal = shopify?.settings;
  const current = signal?.value ?? signal?.current ?? {};
  return normalizeBaseUrl(String(current?.app_base_url ?? current?.appBaseUrl ?? current?.baseUrl ?? ''));
}

function normalizeBaseUrl(input: string): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

function formatCurrency(amount: number): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '$0.00';
  try {
    if (shopify?.i18n?.formatCurrency) return shopify.i18n.formatCurrency(n);
  } catch {}
  return `$${n.toFixed(2)}`;
}

function formatNumber(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  try {
    if (shopify?.i18n?.formatNumber) return shopify.i18n.formatNumber(n);
  } catch {}
  return String(n);
}

function formatTierProgress(remaining: number, metricType: TierMetricType, nextTierName: string): string {
  if (metricType === 'lifetimeEligibleSpend') {
    return `${formatCurrency(remaining)} more lifetime eligible spend to reach ${nextTierName}`;
  }
  return `${formatNumber(remaining)} lifetime point(s) to reach ${nextTierName}`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {raw: text};
  }
}
