import type { LoaderFunctionArgs } from "react-router";
import { verifyAppProxy } from "../lib/proxy.server";
import { computeCustomerLoyalty } from "../lib/loyalty.server";

function jsonResponse(payload: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload, null, 2), { ...init, headers });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { ok, shop, customerId, error, status } = await verifyAppProxy(request);
  if (!ok) return jsonResponse({ ok: false, error }, { status });

  const loyalty = await computeCustomerLoyalty({ shop, customerId });
  return jsonResponse({ ok: true, ...loyalty }, { status: 200 });
}
