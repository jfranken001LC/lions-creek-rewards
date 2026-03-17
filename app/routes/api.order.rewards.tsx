import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { shopFromDest } from "../lib/proxy.server";
import { normalizeCustomerId } from "../lib/loyalty.server";
import { getOrCreateShopSettings } from "../lib/shopSettings.server";
import { buildTierProgress, computeEffectiveEarnRate, getCustomerTierMetrics } from "../lib/tier.server";

type ReadyPayload = {
  ok: true;
  status: "ready";
  pointsEarned: number;
  balance: number;
  currentTierName: string | null;
  effectiveEarnRate: number | null;
  nextTierName: string | null;
  remainingToNext: number | null;
  remainingMetricType: "lifetimeEarned" | "lifetimeEligibleSpend" | null;
  nextRewardMessage: string | null;
};

type PendingPayload = {
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

type RewardsResponse = PendingPayload | ReadyPayload | { ok: false; error: string; hint?: string };

function normOrderId(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/(Order|OrderIdentity)\/(\d+)/i);
  if (m?.[2]) return m[2];
  const m2 = s.match(/Order\/(\d+)/i);
  if (m2?.[1]) return m2[1];
  return s;
}

function buildNextRewardMessage(args: { balance: number; steps: number[]; valueMap: Record<string, any> }): string | null {
  const bal = Number(args.balance);
  if (!Number.isFinite(bal)) return null;

  const steps = (Array.isArray(args.steps) ? args.steps : [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);

  if (!steps.length) return null;

  const lowest = steps[0];
  const lowestValue = Number(args.valueMap?.[String(lowest)]);

  if (bal >= lowest) {
    if (Number.isFinite(lowestValue) && lowestValue > 0) {
      return `You have enough points for $${lowestValue.toFixed(2)} off your next order.`;
    }
    return "You have enough points to redeem a reward on your next order.";
  }

  const diff = Math.max(0, lowest - bal);
  if (Number.isFinite(lowestValue) && lowestValue > 0) {
    return `You're ${diff} point${diff === 1 ? "" : "s"} away from $${lowestValue.toFixed(2)} off your next order.`;
  }

  return `You're ${diff} point${diff === 1 ? "" : "s"} away from your first reward.`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    try {
      const { cors } = await authenticate.public.checkout(request);
      return cors(new Response(null, { status: 204 }));
    } catch {}
    try {
      const { cors } = await authenticate.public.customerAccount(request);
      return cors(new Response(null, { status: 204 }));
    } catch {}

    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
      },
    });
  }

  if (request.method !== "GET") return Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 });

  let cors: ((resp: Response) => Response) | null = null;
  let sessionToken: any = null;

  try {
    const r = await authenticate.public.checkout(request);
    cors = r.cors;
    sessionToken = r.sessionToken;
  } catch {
    const r = await authenticate.public.customerAccount(request);
    cors = r.cors;
    sessionToken = r.sessionToken;
  }

  const token: any = sessionToken as any;
  const dest = token?.dest ?? token?.des ?? token?.iss;
  const shop = shopFromDest(dest);

  if (!shop) {
    return cors!(
      Response.json(
        { ok: false, error: "missing_shop_claim", hint: "Missing dest claim in session token." } satisfies RewardsResponse,
        { status: 401 },
      ),
    );
  }

  const url = new URL(request.url);
  const orderId = normOrderId(url.searchParams.get("orderId") ?? "");
  if (!orderId) {
    return cors!(
      Response.json(
        { ok: false, error: "missing_orderId", hint: "Provide ?orderId=<gid> or numeric id." } satisfies RewardsResponse,
        { status: 400 },
      ),
    );
  }

  const snapshot = await db.orderPointsSnapshot.findUnique({
    where: { shop_orderId: { shop, orderId } },
    select: {
      pointsAwarded: true,
      customerId: true,
      effectiveTierName: true,
      effectiveEarnRate: true,
    } as any,
  } as any);

  if (!snapshot) {
    const pending: PendingPayload = {
      ok: true,
      status: "pending",
      pointsEarned: null,
      balance: null,
      currentTierName: null,
      effectiveEarnRate: null,
      nextTierName: null,
      remainingToNext: null,
      remainingMetricType: null,
      nextRewardMessage: null,
    };

    return cors!(Response.json(pending, { status: 200 }));
  }

  const tokenCustomerId = token?.sub ? normalizeCustomerId(String(token.sub)) : "";
  const snapshotCustomerId = normalizeCustomerId((snapshot as any).customerId);

  if (tokenCustomerId && snapshotCustomerId && tokenCustomerId !== snapshotCustomerId) {
    return cors!(
      Response.json(
        { ok: false, error: "forbidden", hint: "Session token customer does not match the order customer." } satisfies RewardsResponse,
        { status: 403 },
      ),
    );
  }

  const bal = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId: snapshotCustomerId } },
    select: {
      balance: true,
      currentTierName: true,
    } as any,
  } as any);

  const settings = await getOrCreateShopSettings(shop);
  const metrics = await getCustomerTierMetrics(shop, snapshotCustomerId);
  const progress = buildTierProgress(settings, metrics);
  const nextRewardMessage = buildNextRewardMessage({
    balance: (bal as any)?.balance ?? 0,
    steps: Array.isArray(settings.redemptionSteps) ? (settings.redemptionSteps as any) : [],
    valueMap: (settings.redemptionValueMap as any) ?? {},
  });

  const ready: ReadyPayload = {
    ok: true,
    status: "ready",
    pointsEarned: (snapshot as any).pointsAwarded ?? 0,
    balance: (bal as any)?.balance ?? 0,
    currentTierName: (bal as any)?.currentTierName ?? (snapshot as any).effectiveTierName ?? progress.currentTier.name,
    effectiveEarnRate: (snapshot as any).effectiveEarnRate ?? computeEffectiveEarnRate(settings, progress.currentTier),
    nextTierName: progress.nextTier?.name ?? null,
    remainingToNext: progress.nextTier ? progress.remainingToNext : null,
    remainingMetricType: progress.nextTier ? progress.remainingMetricType : null,
    nextRewardMessage,
  };

  return cors!(Response.json(ready, { status: 200 }));
}
