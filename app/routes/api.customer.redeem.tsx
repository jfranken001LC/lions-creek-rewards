// app/routes/api.customer.redeem.tsx
import type { ActionFunctionArgs } from "react-router";
import { json } from "react-router";
import { authenticate } from "../shopify.server";
import { issueRedemptionCode, normalizeCustomerId } from "../lib/redemption.server";

async function readJson(request: Request): Promise<any> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Customer Account UI Extension endpoint.
 *
 * Auth: Authorization: Bearer <customer account session token>
 *
 * Response shape is intentionally flat (extension expects `code` + `expiresAt` at top-level):
 * { ok: true, code, expiresAt, points, valueDollars, redemptionId }
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken, admin } = await authenticate.public.customerAccount(request);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return cors(new Response(null, { status: 204 }));
  }

  try {
    const shop = sessionToken?.dest?.replace(/^https:\/\//, "") ?? "";
    const customerGid = String(sessionToken?.sub ?? "");
    const customerId = normalizeCustomerId(customerGid);

    if (!shop || !customerId) {
      return cors(json({ ok: false, error: "Missing shop or customer identity" }, { status: 401 }));
    }

    const payload = await readJson(request);

    const rawPoints = payload?.points ?? payload?.pointsRequested ?? 0;
    const pointsRequested = Number.isFinite(Number(rawPoints)) ? Math.trunc(Number(rawPoints)) : 0;

    const idemKey =
      String(request.headers.get("x-idempotency-key") ?? payload?.idemKey ?? "").trim() || null;

    const result = await issueRedemptionCode({
      shop,
      admin: admin as any,
      customerId, // numeric ID (canonical)
      customerGid, // optional
      pointsRequested,
      idemKey,
    });

    return cors(
      json(
        {
          ok: true,
          redemptionId: result.redemptionId,
          code: result.code,
          expiresAt: result.expiresAt,
          points: result.points,
          valueDollars: result.valueDollars,
          discountNodeId: result.discountNodeId,
        },
        { headers: { "Cache-Control": "no-store" } },
      ),
    );
  } catch (e: any) {
    return cors(
      json(
        { ok: false, error: e?.message ?? "Redeem failed" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }
};
