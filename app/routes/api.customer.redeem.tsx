import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { applyCustomerAccountCors, preflightCustomerAccountCors } from "../lib/customerAccountCors.server";
import { issueRedemptionCode } from "../lib/redemption.server";
import { getShopSettings } from "../lib/shopSettings.server";
import { normalizeCustomerId, shopFromDest, validateRedeemPoints } from "../lib/loyalty.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflightCustomerAccountCors(request);
  if (request.method !== "POST") return applyCustomerAccountCors(request, new Response("Method Not Allowed", { status: 405 }));

  try {
    const { sessionToken } = await authenticate.public.customerAccount(request);

    const shop = shopFromDest(sessionToken.payload.dest);
    const customerId = normalizeCustomerId(sessionToken.payload.sub);

    if (!shop || !customerId) {
      const res = Response.json({ ok: false, error: "Missing shop/customer claims" }, { status: 401 });
      return applyCustomerAccountCors(request, res);
    }

    const body = (await request.json().catch(() => null)) as any;
    const requestedPoints = body?.points;
    const idempotencyKey = (body?.idempotencyKey ?? "").toString();

    const settings = await getShopSettings(shop);
    const validate = validateRedeemPoints(requestedPoints, settings.redemptionSteps);
    if (!validate.ok) {
      const res = Response.json({ ok: false, error: validate.code }, { status: 400 });
      return applyCustomerAccountCors(request, res);
    }

    const issued = await issueRedemptionCode({
      shop,
      customerId,
      points: validate.points,
      idempotencyKey,
    });

    const res = Response.json({
      ok: true,
      code: issued.code,
      expiry: issued.expiresAt,
      pointsDebited: issued.pointsDebited,
      // extras are safe to ignore:
      valueDollars: issued.valueDollars,
      redemptionId: issued.id,
    });

    return applyCustomerAccountCors(request, res);
  } catch (err: any) {
    const res = Response.json({ ok: false, error: err?.message ?? "Unknown error" }, { status: 500 });
    return applyCustomerAccountCors(request, res);
  }
}
