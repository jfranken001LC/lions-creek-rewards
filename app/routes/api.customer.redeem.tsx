import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getCustomerAccountCorsHeaders } from "../lib/customerAccountCors.server";
import { CustomerSessionError, requireCustomerSession } from "../lib/customerSession.server";
import { unauthenticated } from "../lib/shopify.server";
import { issueRedemptionCode } from "../lib/redemption.server";
import { computeCustomerLoyalty } from "../lib/loyalty.server";

function jsonResponse(payload: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function preflight() {
  return new Response(null, { status: 204, headers: getCustomerAccountCorsHeaders() });
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflight();
  return jsonResponse({ ok: false, error: "Method not allowed" }, { status: 405, headers: getCustomerAccountCorsHeaders() });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, { status: 405, headers: getCustomerAccountCorsHeaders() });
  }

  const cors = getCustomerAccountCorsHeaders();

  try {
    const { shop, customerId } = await requireCustomerSession(request);

    let body: any;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON body" }, { status: 400, headers: cors });
    }

    const points = Number(body?.points);
    if (!Number.isFinite(points) || !Number.isInteger(points) || points <= 0) {
      return jsonResponse({ ok: false, error: "points must be a positive integer" }, { status: 400, headers: cors });
    }

    const idemKey = request.headers.get("Idempotency-Key") || request.headers.get("X-Idempotency-Key") || undefined;

    const { admin } = await unauthenticated.admin(shop);

    const redemption = await issueRedemptionCode({
      shop,
      admin,
      customerId,
      pointsRequested: points,
      idemKey,
    });

    const loyalty = await computeCustomerLoyalty({ shop, customerId });

    return jsonResponse(
      {
        ok: true,
        redemption: {
          code: redemption.code,
          points: redemption.points,
          value: redemption.valueDollars,
          expiresAt: redemption.expiresAt,
          discountNodeId: redemption.discountNodeId,
        },
        loyalty,
        ...loyalty,
      },
      { status: 200, headers: cors },
    );
  } catch (err: any) {
    if (err instanceof CustomerSessionError) {
      return jsonResponse({ ok: false, error: err.message, code: err.code }, { status: err.status, headers: cors });
    }
    return jsonResponse({ ok: false, error: err?.message ?? "Unable to redeem" }, { status: 400, headers: cors });
  }
}
