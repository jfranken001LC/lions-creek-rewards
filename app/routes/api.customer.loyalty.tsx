import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { applyCustomerAccountCors, preflightCustomerAccountCors } from "../lib/customerAccountCors.server";
import { getCustomerLoyaltyPayload, normalizeCustomerId, shopFromDest } from "../lib/loyalty.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { sessionToken } = await authenticate.public.customerAccount(request);

  const shop = shopFromDest(sessionToken.payload.dest);
  const customerId = normalizeCustomerId(sessionToken.payload.sub);

  if (!shop || !customerId) {
    const res = Response.json({ ok: false, error: "Missing shop/customer claims" }, { status: 401 });
    return applyCustomerAccountCors(request, res);
  }

  const payload = await getCustomerLoyaltyPayload({ shop, customerId });
  const res = Response.json({ ok: true, ...payload });
  return applyCustomerAccountCors(request, res);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflightCustomerAccountCors(request);
  const res = new Response("Method Not Allowed", { status: 405 });
  return applyCustomerAccountCors(request, res);
}
