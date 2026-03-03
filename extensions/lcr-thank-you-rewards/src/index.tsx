/* eslint-disable react/self-closing-comp */
import "@shopify/ui-extensions/preact";

import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

declare const shopify: any;

type RewardsPending = {
  ok: true;
  status: "pending";
  pointsEarned: null;
  balance: null;
  nextRewardMessage: string | null;
};

type RewardsReady = {
  ok: true;
  status: "ready";
  pointsEarned: number;
  balance: number;
  nextRewardMessage: string | null;
};

type RewardsErr = { ok: false; error: string; hint?: string };

type RewardsResponse = RewardsPending | RewardsReady | RewardsErr;

export default async () => {
  render(<Extension />, document.body);
};

function normalizeUrl(u: string): string {
  return String(u || "").trim();
}

function normalizeBaseUrl(u: string): string {
  return normalizeUrl(u).replace(/\/+$/, "");
}

function getSettingsCurrent(): any {
  // Per Shopify 2025-10+ UI extensions, settings are exposed on global shopify object.
  return shopify?.settings?.current ?? shopify?.settings ?? null;
}

function getAppBaseUrlFromSettings(): string {
  const s = getSettingsCurrent();
  const raw = (s && (s.app_base_url || s.appBaseUrl || s.baseUrl)) || "";
  return normalizeBaseUrl(String(raw || ""));
}

function getRewardsPageUrlFromSettings(): string {
  const s = getSettingsCurrent();
  const raw = (s && (s.rewards_page_url || s.rewardsPageUrl || s.rewards_url)) || "";
  const u = normalizeUrl(String(raw || ""));

  // Default: customer accounts deep link to the full-page extension.
  // Merchant can override to absolute URL if their account URL differs.
  return u || "/account/lcr-loyalty-dashboard/";
}

function useSettingsBaseUrl(): { appBaseUrl: string; rewardsPageUrl: string } {
  const [appBaseUrl, setAppBaseUrl] = useState<string>(() => getAppBaseUrlFromSettings());
  const [rewardsPageUrl, setRewardsPageUrl] = useState<string>(() => getRewardsPageUrlFromSettings());

  useEffect(() => {
    const sig = shopify?.settings;
    if (sig && typeof sig.subscribe === "function") {
      return sig.subscribe((next: any) => {
        const rawBase = next?.app_base_url ?? next?.appBaseUrl ?? next?.baseUrl ?? "";
        setAppBaseUrl(normalizeBaseUrl(String(rawBase || "")));

        const rawRewards = next?.rewards_page_url ?? next?.rewardsPageUrl ?? next?.rewards_url ?? "";
        const u = normalizeUrl(String(rawRewards || ""));
        setRewardsPageUrl(u || "/account/lcr-loyalty-dashboard/");
      });
    }
  }, []);

  return { appBaseUrl, rewardsPageUrl };
}

function useOrderId(): string | null {
  const initial = shopify?.orderConfirmation?.value?.order?.id ?? null;
  const [orderId, setOrderId] = useState<string | null>(initial ? String(initial) : null);

  useEffect(() => {
    const sig = shopify?.orderConfirmation;
    if (sig && typeof sig.subscribe === "function") {
      return sig.subscribe((oc: any) => {
        const id = oc?.order?.id ?? null;
        setOrderId(id ? String(id) : null);
      });
    }
  }, []);

  return orderId;
}

function Extension() {
  const { appBaseUrl, rewardsPageUrl } = useSettingsBaseUrl();
  const orderId = useOrderId();

  const [state, setState] = useState<RewardsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const canPoll = useMemo(() => Boolean(appBaseUrl && orderId), [appBaseUrl, orderId]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (!canPoll) return;

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
  }, [canPoll, appBaseUrl, orderId]);

  if (!appBaseUrl) {
    return (
      <s-section>
        <s-banner status="warning">
          <s-text emphasis="bold">Lions Creek Rewards</s-text>
          <s-text>Missing extension setting: app_base_url</s-text>
        </s-banner>
      </s-section>
    );
  }

  return (
    <s-section>
      <s-stack direction="block" spacing="tight">
        <s-text emphasis="bold">Lions Creek Rewards</s-text>

        {loading && (
          <s-stack direction="inline" spacing="tight" align="center">
            <s-spinner size="small"></s-spinner>
            <s-text>Updating your rewards…</s-text>
          </s-stack>
        )}

        {!state && !loading && <s-text>Checking your rewards…</s-text>}

        {state && state.ok === false && (
          <s-banner status="critical">
            <s-text>{state.error}</s-text>
            {state.hint ? <s-text>{state.hint}</s-text> : null}
          </s-banner>
        )}

        {state && state.ok === true && state.status === "pending" && (
          <s-banner status="info">
            <s-text>Rewards are being finalized for this order. Please check back shortly.</s-text>
          </s-banner>
        )}

        {state && state.ok === true && state.status === "ready" && (
          <s-stack direction="block" spacing="tight">
            <s-text>Points earned: {state.pointsEarned}</s-text>
            <s-text>Your balance: {state.balance}</s-text>
            {state.nextRewardMessage ? <s-text>{state.nextRewardMessage}</s-text> : null}
          </s-stack>
        )}

        <s-button variant="secondary" href={rewardsPageUrl}>
          View Rewards
        </s-button>
      </s-stack>
    </s-section>
  );
}
