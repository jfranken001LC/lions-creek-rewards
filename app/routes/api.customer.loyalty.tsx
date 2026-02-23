import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { applyCustomerAccountCors, preflightCustomerAccountCors } from "../lib/customerAccountCors.server";
import { verifyCustomerSessionToken } from "../lib/customerSession.server";
import { getCustomerLoyaltyPayload, normalizeCustomerId } from "../lib/loyalty.server";
import { shopFromDest } from "../lib/proxy.server";

type CustomerClaims = { dest?: unknown; sub?: unknown; [key: string]: unknown };

function extractCustomerClaims(sessionToken: any): CustomerClaims | null {
  // Different versions of Shopify App packages return different shapes:
  // - string JWT
  // - { token: string, payload?: object }
  // - { payload: object }
  // - payload object itself
  if (!sessionToken) return null;

  // Prefer an already-decoded payload if present
  const payload = sessionToken?.payload ?? sessionToken?.claims;
  if (payload && typeof payload === "object") return payload as CustomerClaims;

  // If it's a raw JWT string, verify + decode it
  if (typeof sessionToken === "string") {
    return verifyCustomerSessionToken(sessionToken) as unknown as CustomerClaims;
  }

  // Some shapes carry the raw token in .token
  const raw = sessionToken?.token;
  if (typeof raw === "string") {
    return verifyCustomerSessionToken(raw) as unknown as CustomerClaims;
  }

  // Last resort: treat the object itself as claims
  if (typeof sessionToken === "object") return sessionToken as CustomerClaims;

  return null;
}

export async function loader({ request }: LoaderFunctionArgs) {
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

    const payload = await getCustomerLoyaltyPayload(shop, customerId);
    const res = Response.json({ ok: true, ...payload });
    return applyCustomerAccountCors(request, res);
  } catch (e: any) {
    // Important: if authenticate.public.customerAccount throws a Response (redirect/401),
    // we must still attach CORS headers or the extension will see a generic "Failed to fetch".
    if (e instanceof Response) {
      return applyCustomerAccountCors(request, e);
    }
    const res = Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 401 });
    return applyCustomerAccountCors(request, res);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflightCustomerAccountCors(request);
  const res = new Response("Method Not Allowed", { status: 405 });
  return applyCustomerAccountCors(request, res);
}
