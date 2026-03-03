import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireAppProxyContext } from "../lib/appProxy.server";
import { issueRedemptionCode } from "../lib/redemption.server";

function json(payload: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload, null, 2), { ...init, headers });
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  return json({ ok: false, error: "Method Not Allowed" }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, { status: 405 });

  try {
    const { shop, customerId } = requireAppProxyContext(request);

    const body = (await request.json().catch(() => null)) as any;

    const pointsToRedeemRaw =
      body?.pointsToRedeem ?? body?.pointsToRedeemRaw ?? body?.points ?? body?.pointsRequested;
    const pointsToRedeem = Number(pointsToRedeemRaw);

    const idempotencyKey = body?.idempotencyKey ? String(body.idempotencyKey) : undefined;

    const issued = await issueRedemptionCode({
      shop,
      customerId,
      pointsRequested: pointsToRedeem,
      idempotencyKey,
    });

    if (!issued.ok) return json(issued, { status: 400 });

    // v1.8 contract
    return json(
      {
        ok: true,
        code: issued.code,
        redemptionId: issued.redemptionId,
        status: issued.status,
        expiresAt: issued.expiresAt,
      },
      { status: 200 },
    );
  } catch (e: any) {
    if (e instanceof Response) return e;
    return json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
