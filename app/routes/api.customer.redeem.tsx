import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { applyCustomerAccountCors, preflightCustomerAccountCors } from "../lib/customerAccountCors.server";
import { verifyCustomerSessionToken } from "../lib/customerSession.server";
import { issueRedemptionCode } from "../lib/redemption.server";
import { normalizeCustomerId } from "../lib/loyalty.server";
import { shopFromDest } from "../lib/proxy.server";

type CustomerClaims = { dest?: unknown; sub?: unknown; [key: string]: unknown };

function extractCustomerClaims(sessionToken: any): CustomerClaims | null {
  const payload = sessionToken?.payload ?? sessionToken?.claims;
  if (payload && typeof payload === "object") return payload as CustomerClaims;

  if (typeof sessionToken === "string") {
    return verifyCustomerSessionToken(sessionToken) as unknown as CustomerClaims;
  }

  const raw = sessionToken?.token;
  if (typeof raw === "string") {
    return verifyCustomerSessionToken(raw) as unknown as CustomerClaims;
  }

  if (sessionToken && typeof sessionToken === "object") return sessionToken as CustomerClaims;
  return null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflightCustomerAccountCors(request);
  const res = new Response("Method Not Allowed", { status: 405 });
  return applyCustomerAccountCors(request, res);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflightCustomerAccountCors(request);

  try {
    const { sessionToken } = await authenticate.public.customerAccount(request);
    const claims = extractCustomerClaims(sessionToken);

    const shop = shopFromDest(claims?.dest);
    const customerId = normalizeCustomerId(String(claims?.sub ?? ""));

    if (!shop || !customerId) {
      const res = Response.json(
        { ok: false, error: "Missing shop/customer claims (dest/sub) in customer session token" },
        { status: 401 },
      );
      return applyCustomerAccountCors(request, res);
    }

    const body = (await request.json().catch(() => null)) as any;

    // Primary contract: pointsToRedeem (kept compatible with older 'points')
    const requestedPointsRaw = body?.pointsToRedeem ?? body?.points;
    const requestedPoints = Number(requestedPointsRaw);
    const idempotencyKey = body?.idempotencyKey ? String(body.idempotencyKey) : undefined;

    const issued = await issueRedemptionCode({
      shop,
      customerId,
      pointsRequested: requestedPoints,
      idempotencyKey,
    });

    const res = Response.json(issued, { status: issued.ok ? 200 : 400 });
    return applyCustomerAccountCors(request, res);
  } catch (e: any) {
    if (e instanceof Response) {
      return applyCustomerAccountCors(request, e);
    }
    const res = Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
    return applyCustomerAccountCors(request, res);
  }
}
