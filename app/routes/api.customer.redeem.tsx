import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { applyCustomerAccountCors, preflightCustomerAccountCors } from "../lib/customerAccountCors.server";
import { issueRedemptionCode } from "../lib/redemption.server";
import { normalizeCustomerId } from "../lib/loyalty.server";
import { shopFromDest } from "../lib/proxy.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflightCustomerAccountCors(request);
  const res = new Response("Method Not Allowed", { status: 405 });
  return applyCustomerAccountCors(request, res);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflightCustomerAccountCors(request);

  try {
    const { sessionToken } = await authenticate.public.customerAccount(request);

    const shop = shopFromDest(sessionToken.payload.dest);
    const customerId = normalizeCustomerId(sessionToken.payload.sub);

    if (!shop || !customerId) {
      const res = Response.json({ ok: false, error: "Missing shop/customer claims" }, { status: 401 });
      return applyCustomerAccountCors(request, res);
    }

    const body = (await request.json().catch(() => null)) as any;
    const requestedPoints = Number(body?.points);
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
    const res = Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
    return applyCustomerAccountCors(request, res);
  }
}
