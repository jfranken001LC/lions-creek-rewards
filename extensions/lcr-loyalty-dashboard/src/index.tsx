import '@shopify/ui-extensions/preact';

import {render} from 'preact';
import {useEffect, useMemo, useState} from 'preact/hooks';

declare const shopify: any;

type RedemptionStatus = 'ISSUED' | 'APPLIED' | 'EXPIRED' | 'CANCELED';

type LoyaltyPayloadOk = {
  ok: true;
  shop: string;
  customerId: string;
  points: {
    balance: number;
    lifetimeEarned: number;
    lifetimeRedeemed: number;
    lastActivityAt: string | null;
    expireAfterDays: number | null;
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
  settings: {
    earnRate: number;
    minOrderDollars: number;
    redemptionExpiryHours: number;
    redemptionSteps: number[];
    redemptionValueMap: Record<string, number>;
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

type RedemptionOption = {
  points: number;
  dollars: number;
  label: string;
};

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const [appBaseUrl, setAppBaseUrl] = useState<string>(() => getAppBaseUrlFromSettings());
  const [loading, setLoading] = useState<boolean>(true);
  const [payload, setPayload] = useState<LoyaltyPayloadOk | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedPoints, setSelectedPoints] = useState<number | null>(null);
  const [redeeming, setRedeeming] = useState<boolean>(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // React to settings changes while in dev preview (Shopify config editor updates are signals).
  useEffect(() => {
    const signal = shopify?.settings;
    if (signal && typeof signal.subscribe === 'function') {
      return signal.subscribe((next: any) => {
        const nextBase = normalizeBaseUrl(String(next?.app_base_url ?? ''));
        if (nextBase) setAppBaseUrl(nextBase);
      });
    }
    return undefined;
  }, []);

  const redemptionOptions = useMemo(() => {
    if (!payload) return [];
    return buildRedemptionOptions(payload.settings);
  }, [payload]);

  // Keep selectedPoints valid as options change.
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

  // Load loyalty data.
  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      setSuccessMessage(null);

      if (!appBaseUrl) {
        setLoading(false);
        setError(
          'Missing App Base URL. Ask the merchant to set the "App Base URL" setting for this extension.',
        );
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
    if (!payload || !appBaseUrl) return;
    if (!selectedPoints) return;

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

      // Optimistically update local state (server already deducted points + issued/returned the active code).
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

  return (
    <s-page heading="Lions Creek Rewards" subheading="Earn points on every order. Redeem points for discounts.">
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

              <s-text type="small">
                Lifetime earned: {formatNumber(payload.points.lifetimeEarned)} · Lifetime redeemed:{' '}
                {formatNumber(payload.points.lifetimeRedeemed)}
              </s-text>

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
                    disabled={redeeming || !selectedPoints || selectedPoints > available}
                    loading={redeeming}
                    onClick={onRedeem}
                  >
                    Redeem
                  </s-button>

                  {selectedPoints && selectedPoints > available ? (
                    <s-text type="small">You don’t have enough points for that reward.</s-text>
                  ) : null}

                  <s-text type="small">
                    Earn rate: {formatNumber(payload.settings.earnRate)} point(s) per {formatCurrency(1)} spent · Minimum
                    order: {formatCurrency(payload.settings.minOrderDollars)}
                  </s-text>
                </>
              )}
            </s-stack>
          </s-section>
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

function buildRedemptionOptions(settings: LoyaltyPayloadOk['settings']): RedemptionOption[] {
  const steps = Array.isArray(settings.redemptionSteps) ? settings.redemptionSteps : [];
  const map = settings.redemptionValueMap ?? {};

  const opts = steps
    .map((points) => {
      const dollars = Number(map[String(points)] ?? 0);
      return {
        points,
        dollars,
        label: `${formatNumber(points)} points → ${formatCurrency(dollars)} off`,
      };
    })
    .filter((o) => o.points > 0 && o.dollars > 0)
    .sort((a, b) => a.points - b.points);

  return opts;
}

function getAppBaseUrlFromSettings(): string {
  const signal = shopify?.settings;
  const current = signal?.value ?? signal?.current ?? {};
  return normalizeBaseUrl(String(current?.app_base_url ?? ''));
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
    // In customer account UI extensions, i18n provides currency formatting.
    if (shopify?.i18n?.formatCurrency) {
      return shopify.i18n.formatCurrency(n);
    }
  } catch {
    // fall through
  }

  return `$${n.toFixed(2)}`;
}

function formatNumber(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);

  try {
    if (shopify?.i18n?.formatNumber) {
      return shopify.i18n.formatNumber(n);
    }
  } catch {
    // fall through
  }

  return String(n);
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
