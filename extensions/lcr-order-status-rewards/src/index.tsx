import "@shopify/ui-extensions/preact";

import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

declare const shopify: any;
declare const process: { env?: Record<string, string | undefined> };

type TierMetricType = "lifetimeEarned" | "lifetimeEligibleSpend";

type RewardsPending = {
  ok: true;
  status: "pending";
  pointsEarned: null;
  balance: null;
  currentTierName: null;
  effectiveEarnRate: null;
  nextTierName: null;
  remainingToNext: null;
  remainingMetricType: null;
  nextRewardMessage: string | null;
};

type RewardsReady = {
  ok: true;
  status: "ready";
  pointsEarned: number;
  balance: number;
  currentTierName: string | null;
  effectiveEarnRate: number | null;
  nextTierName: string | null;
  remainingToNext: number | null;
  remainingMetricType: TierMetricType | null;
  nextRewardMessage: string | null;
};

type RewardsErr = { ok: false; error: string; hint?: string };

type RewardsResponse = RewardsPending | RewardsReady | RewardsErr;

export default async () => {
  render(<Extension />, document.body);
};

function normalizeBaseUrl(u: string): string {
  return String(u || "").trim().replace(/\/+$/, "");
}

function getInjectedAppBaseUrl(): string {
  try {
    return normalizeBaseUrl(String(process?.env?.APP_URL ?? ""));
  } catch {
    return "";
  }
}

function getLegacyAppBaseUrlFromSettings(): string {
  const s = shopify?.settings?.current ?? shopify?.settings?.value ?? {};
  const raw = (s && (s.app_base_url || s.appBaseUrl || s.baseUrl)) || "";
  return normalizeBaseUrl(String(raw || ""));
}

function getResolvedAppBaseUrl(): string {
  return getInjectedAppBaseUrl() || getLegacyAppBaseUrlFromSettings();
}

function getRewardsPageUrlFromSettings(): string {
  const s = shopify?.settings?.current ?? shopify?.settings?.value ?? {};
  const raw = (s && (s.rewards_page_url || s.rewardsPageUrl || s.rewards_url)) || "";
  const normalized = String(raw || "").trim();
  return normalized || "extension:lcr-loyalty-dashboard/";
}

function Extension() {
  const [appBaseUrl, setAppBaseUrl] = useState<string>(() => getResolvedAppBaseUrl());
  const [rewardsPageUrl, setRewardsPageUrl] = useState<string>(() => getRewardsPageUrlFromSettings());
  const [orderId, setOrderId] = useState<string | null>(null);
  const [state, setState] = useState<RewardsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    const signal = shopify?.settings;
    if (signal && typeof signal.subscribe === "function") {
      return signal.subscribe((next: any) => {
        const rawRewards = next?.rewards_page_url ?? next?.rewardsPageUrl ?? next?.rewards_url ?? "";
        setRewardsPageUrl(String(rawRewards || "").trim() || "extension:lcr-loyalty-dashboard/");
        setAppBaseUrl(getInjectedAppBaseUrl() || normalizeBaseUrl(String(next?.app_base_url ?? next?.appBaseUrl ?? next?.baseUrl ?? "")));
      });
    }
  }, []);

  useEffect(() => {
    const sig = shopify?.order;
    if (sig && typeof sig.subscribe === "function") {
      return sig.subscribe((payload: any) => {
        const id = payload?.id ?? payload?.order?.id ?? null;
        if (id) setOrderId(String(id));
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (!appBaseUrl || !orderId) return;
      setLoading(true);

      const maxAttempts = 20;
      const delayMs = 1500;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const token = await shopify.sessionToken.get();
          const url = `${appBaseUrl}/api/order/rewards?orderId=${encodeURIComponent(String(orderId))}`;
          const res = await fetch(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          });

          const data = (await res.json().catch(() => null)) as RewardsResponse | null;
          if (cancelled) return;

          if (!data) {
            setState({ ok: false, error: "Invalid response from server" });
            setLoading(false);
            return;
          }

          setState(data);

          if (data.ok === true && data.status === "ready") {
            setLoading(false);
            return;
          }

          await new Promise((r) => setTimeout(r, delayMs));
        } catch (e: any) {
          if (cancelled) return;
          setState({ ok: false, error: e?.message ?? String(e) });
          setLoading(false);
          return;
        }
      }

      if (!cancelled) setLoading(false);
    }

    poll();
    return () => {
      cancelled = true;
    };
  }, [appBaseUrl, orderId]);

  const message = useMemo(() => {
    if (!appBaseUrl) return "Rewards details are not available right now.";
    if (!orderId) return "Loading your order…";
    if (!state || (state.ok === true && state.status === "pending")) return "We’re calculating your rewards…";
    if (state.ok === false) return `Rewards: ${state.error}`;
    const tierText = state.currentTierName ? ` Tier: ${state.currentTierName}.` : "";
    const nextTierText = formatNextTierText(state.nextTierName, state.remainingToNext, state.remainingMetricType);
    return `You earned ${state.pointsEarned} point(s). Balance: ${state.balance}.${tierText}${nextTierText}`;
  }, [appBaseUrl, orderId, state]);

  return (
    <s-section>
      <s-stack direction="block" spacing="tight">
        <s-text emphasis="bold">Lions Creek Rewards</s-text>
        {loading ? <s-text>Updating your rewards…</s-text> : null}
        <s-text>{message}</s-text>
        {state && state.ok === true && state.status === "ready" && state.nextRewardMessage ? (
          <s-text>{state.nextRewardMessage}</s-text>
        ) : null}
        <s-button variant="secondary" href={rewardsPageUrl}>
          View rewards
        </s-button>
      </s-stack>
    </s-section>
  );
}

function formatNextTierText(
  nextTierName: string | null,
  remainingToNext: number | null,
  remainingMetricType: TierMetricType | null,
): string {
  if (!nextTierName || remainingToNext == null || !remainingMetricType) return "";
  if (remainingMetricType === "lifetimeEligibleSpend") {
    return ` ${formatCurrency(remainingToNext)} more lifetime eligible spend to reach ${nextTierName}.`;
  }
  return ` ${remainingToNext} point(s) to reach ${nextTierName}.`;
}

function formatCurrency(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}
