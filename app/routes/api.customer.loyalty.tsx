// app/routes/api.customer.loyalty.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { shopify } from "../shopify.server";
import { getCustomerLoyaltyPayload, normalizeCustomerId, shopFromDest } from "../lib/loyalty.server";

async function handle(request: Request) {
  // Official customer account session-token auth + CORS helper
  const { sessionToken, cors } = await shopify.authenticate.public.customerAccount(request, {
    corsHeaders: ["Authorization", "Content-Type"],
  });

  // Preflight support
  if (request.method === "OPTIONS") {
    return cors(new Response(null, { status: 204 }));
  }

  const shop = shopFromDest((sessionToken as any).dest);
  const customerId = normalizeCustomerId((sessionToken as any).sub);

  if (!shop) {
    const res = Response.json({ ok: false, error: "invalid_shop" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    return cors(res);
  }

  if (!customerId) {
    const res = Response.json(
      { ok: false, error: "customer_not_logged_in" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
    return cors(res);
  }

  const payload = await getCustomerLoyaltyPayload({ shop, customerId });
  const res = Response.json({ ok: true, ...payload }, { headers: { "Cache-Control": "no-store" } });
  return cors(res);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handle(request);
}

// Some extension stacks POST the “loyalty refresh” call.
export async function action({ request }: ActionFunctionArgs) {
  return handle(request);
}
