import type { LoaderFunctionArgs } from "react-router";
import { verifyAppProxy } from "../lib/proxy.server";
import { computeCustomerLoyalty } from "../lib/loyalty.server";

function jsonResponse(payload: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const proxy = await verifyAppProxy(request);
  if (!proxy.ok) return jsonResponse({ ok: false, error: proxy.error }, { status: 401 });
  if (!proxy.customerId) return jsonResponse({ ok: false, error: "Missing customer" }, { status: 400 });

  const loyalty = await computeCustomerLoyalty({ shop: proxy.shop, customerId: proxy.customerId });
  return jsonResponse({ ok: true, loyalty, ...loyalty }, { status: 200 });
}
