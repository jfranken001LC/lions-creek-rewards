import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getCustomerLoyaltyPayload, normalizeCustomerId } from "../lib/loyalty.server";
import { shopFromDest } from "../lib/proxy.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    // Shopify recommended pattern: rely on the app package to validate the JWT
    // and use the returned `cors` helper to set correct response headers.
    const { cors, sessionToken } = await authenticate.public.customerAccount(request);

    // Preflight
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    // sessionToken is a decoded JwtPayload.
    const token: any = sessionToken as any;
    const dest = token?.dest ?? token?.des ?? token?.iss;
    const shop = shopFromDest(dest);

    if (!shop) {
      const isDev = process.env.NODE_ENV !== "production";
      return cors(
        Response.json(
          {
            ok: false,
            error: "Missing shop claim (dest) in customer session token",
            ...(isDev ? { tokenKeys: Object.keys(token || {}) } : null),
          },
          { status: 401 },
        ),
      );
    }

    // `sub` is optional for customer-account session tokens.
    const rawSub = token?.sub;
    const customerId = rawSub ? normalizeCustomerId(String(rawSub)) : "";
    if (!customerId) {
      const isDev = process.env.NODE_ENV !== "production";
      return cors(
        Response.json(
          {
            ok: false,
            error: "Customer ID claim (sub) is missing in customer session token",
            hint:
              "Ensure the customer is logged in AND the app has customer access scope customer_read_customers (plus extension api_access/network_access enabled and approved).",
            ...(isDev ? { tokenKeys: Object.keys(token || {}) } : null),
          },
          { status: 403 },
        ),
      );
    }

    const payload = await getCustomerLoyaltyPayload(shop, customerId);
    return cors(Response.json({ ok: true, ...payload }));
  } catch (e: any) {
    // If authenticate.public.customerAccount throws a Response, it should already include
    // the correct CORS behavior (when using the official package). Return it directly.
    if (e instanceof Response) return e;
    return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 401 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  // No POST support here; keep CORS-preflight-friendly.
  const { cors } = await authenticate.public.customerAccount(request);
  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  return cors(new Response("Method Not Allowed", { status: 405 }));
}
