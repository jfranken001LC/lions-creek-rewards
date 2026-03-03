import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { shopFromDest } from "../lib/proxy.server";
import { normalizeCustomerId } from "../lib/loyalty.server";
import { getOrCreateShopSettings } from "../lib/shopSettings.server";

type RewardsResponse =
  | {
      ok: true;
      status: "pending";
      pointsEarned: null;
      balance: null;
      nextRewardMessage: string | null;
    }
  | {
      ok: true;
      status: "ready";
      pointsEarned: number;
      balance: number;
      nextRewardMessage: string | null;
    }
  | { ok: false; error: string; hint?: string };

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
  // v1.8 spec intent:
  // - If balance >= lowest redemption step -> "You have enough points for $X off next order"
  // - Else -> "You are Y points away" (optionally mention the first reward value)
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
  // Preflight for extensions (cross-origin fetch from checkout/customer account UIs)
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

  // Authenticate session token: checkout OR customer-account.
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
  const rawOrderId = url.searchParams.get("orderId") ?? "";
  const orderId = normOrderId(rawOrderId);
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
    select: { pointsAwarded: true, customerId: true },
  });

  if (!snapshot) {
    const pending: RewardsResponse = {
      ok: true,
      status: "pending",
      pointsEarned: null,
      balance: null,
      nextRewardMessage: null,
    };

    // Still return 200 so the UI can poll.
    return cors!(Response.json(pending, { status: 200 }));
  }

  const tokenCustomerId = token?.sub ? normalizeCustomerId(String(token.sub)) : "";
  const snapshotCustomerId = normalizeCustomerId(snapshot.customerId);

  // If the token includes a customer identity, enforce it matches the order’s customer.
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
    select: { balance: true },
  });

  const settings = await getOrCreateShopSettings(shop);
  const nextRewardMessage = buildNextRewardMessage({
    balance: bal?.balance ?? 0,
    steps: Array.isArray(settings.redemptionSteps) ? (settings.redemptionSteps as any) : [],
    valueMap: (settings.redemptionValueMap as any) ?? {},
  });

  const ready: RewardsResponse = {
    ok: true,
    status: "ready",
    pointsEarned: snapshot.pointsAwarded ?? 0,
    balance: bal?.balance ?? 0,
    nextRewardMessage,
  };

  return cors!(Response.json(ready, { status: 200 }));
}
