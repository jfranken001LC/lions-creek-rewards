import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { applyCustomerAccountCors, preflightCustomerAccountCors } from "../lib/customerAccountCors.server";
import { getCustomerLoyaltyPayload, normalizeCustomerId } from "../lib/loyalty.server";
import { shopFromDest } from "../lib/proxy.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflightCustomerAccountCors(request);

  try {
    const { sessionToken } = await authenticate.public.customerAccount(request);

    const shop = shopFromDest(sessionToken.payload.dest);
    const customerId = normalizeCustomerId(sessionToken.payload.sub);

    if (!shop || !customerId) {
      const res = Response.json({ ok: false, error: "Missing shop/customer claims" }, { status: 401 });
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
