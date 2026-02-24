import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { issueRedemptionCode } from "../lib/redemption.server";
import { normalizeCustomerId } from "../lib/loyalty.server";
import { shopFromDest } from "../lib/proxy.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { cors } = await authenticate.public.customerAccount(request);
  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  return cors(new Response("Method Not Allowed", { status: 405 }));
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { cors, sessionToken } = await authenticate.public.customerAccount(request);

    // Preflight
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

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

    return cors(Response.json(issued, { status: issued.ok ? 200 : 400 }));
  } catch (e: any) {
    if (e instanceof Response) return e;
    return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
