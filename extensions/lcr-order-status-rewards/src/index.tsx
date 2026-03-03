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

function normalizeBaseUrl(u: string): string {
  return String(u || "").trim().replace(/\/+$/, "");
}

function getAppBaseUrlFromSettings(): string {
  const s = shopify?.settings?.current;
  const raw =
    (s && (s.app_base_url || s.appBaseUrl || s.baseUrl)) ||
    shopify?.settings?.app_base_url ||
    "";
  return normalizeBaseUrl(String(raw || ""));
}

function Extension() {
  const [appBaseUrl, setAppBaseUrl] = useState<string>(() => getAppBaseUrlFromSettings());
  const [orderId, setOrderId] = useState<string | null>(null);

  const [state, setState] = useState<RewardsResponse | null>(null);

  useEffect(() => {
    // Settings signal updates in dev preview
    const signal = shopify?.settings;
    if (signal && typeof signal.subscribe === "function") {
      return signal.subscribe((next: any) => {
        const raw = next?.app_base_url ?? next?.appBaseUrl ?? next?.baseUrl ?? "";
        setAppBaseUrl(normalizeBaseUrl(String(raw)));
      });
    }
  }, []);

  useEffect(() => {
    // Order API in customer account Order Status targets
    const sig = shopify?.order;
    if (sig && typeof sig.subscribe === "function") {
      return sig.subscribe((o: any) => {
        const id = o?.id ?? o?.order?.id ?? null;
        if (id) setOrderId(String(id));
      });
    }

    // Fallback: sometimes API is nested
    const api = shopify?.api;
    const sig2 = api?.order;
    if (sig2 && typeof sig2.subscribe === "function") {
      return sig2.subscribe((o: any) => {
        const id = o?.id ?? o?.order?.id ?? null;
        if (id) setOrderId(String(id));
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (!appBaseUrl || !orderId) return;

      const maxAttempts = 20;
      const delayMs = 1500;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const token = await shopify.sessionToken.get();
          const url = `${appBaseUrl}/api/order/rewards?orderId=${encodeURIComponent(orderId)}`;
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

          if (data.ok === true && data.status === "ready") return;

          await new Promise((r) => setTimeout(r, delayMs));
        } catch (e: any) {
          if (cancelled) return;
          setState({ ok: false, error: e?.message ?? String(e) });
          return;
        }
      }
    }

    poll();

    return () => {
      cancelled = true;
    };
  }, [appBaseUrl, orderId]);

  const message = useMemo(() => {
    if (!appBaseUrl) return { kind: "warn", text: "Rewards block is missing its base URL configuration." };
    if (!orderId) return { kind: "loading", text: "Loading order…" };
    if (!state || (state.ok === true && state.status === "pending")) return { kind: "loading", text: "Processing rewards…" };
    if (state.ok === false) return { kind: "warn", text: `Rewards: ${state.error}` };
    return { kind: "ok", text: `You earned ${state.pointsEarned} point(s). Balance: ${state.balance}.` };
  }, [appBaseUrl, orderId, state]);

  return (
    <s-section>
      <s-stack direction="block" spacing="tight">
        <s-text emphasis="bold">Lions Creek Rewards</s-text>
        <s-text>{message.text}</s-text>
        {state && state.ok === true && state.status === "ready" && state.nextRewardMessage ? (
          <s-text>{state.nextRewardMessage}</s-text>
        ) : null}
        <s-button variant="secondary" href="extension:lcr-loyalty-dashboard/">
          View rewards
        </s-button>
      </s-stack>
    </s-section>
  );
}
