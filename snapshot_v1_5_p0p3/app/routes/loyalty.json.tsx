import type { LoaderFunctionArgs } from "react-router";
import { verifyAppProxy } from "../lib/proxy.server";
import { computeCustomerLoyalty } from "../lib/loyalty.server";

function jsonResponse(payload: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload, null, 2), { ...init, headers });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const result = verifyAppProxy(request);
  if (!result.ok) return jsonResponse({ ok: false, error: result.error }, { status: result.status });

  if (!result.customerId) {
    return jsonResponse({ ok: false, error: "Missing customerId" }, { status: 401 });
  }

  const loyalty = await computeCustomerLoyalty({ shop: result.shop, customerId: result.customerId });
  return jsonResponse({ ok: true, ...loyalty }, { status: 200 });
}
