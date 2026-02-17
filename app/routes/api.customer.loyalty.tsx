import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getCustomerAccountCorsHeaders } from "../lib/customerAccountCors.server";
import { requireCustomerSession, CustomerSessionError } from "../lib/customerSession.server";
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
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, { status: 405, headers: getCustomerAccountCorsHeaders() });
  }

  try {
    const { shop, customerId } = await requireCustomerSession(request);
    const loyalty = await computeCustomerLoyalty({ shop, customerId });

    return jsonResponse(
      { ok: true, loyalty, ...loyalty },
      { status: 200, headers: getCustomerAccountCorsHeaders() },
    );
  } catch (err: any) {
    const cors = getCustomerAccountCorsHeaders();
    if (err instanceof CustomerSessionError) {
      return jsonResponse({ ok: false, error: err.message, code: err.code }, { status: err.status, headers: cors });
    }
    return jsonResponse({ ok: false, error: err?.message ?? "Internal error" }, { status: 500, headers: cors });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflight();
  return jsonResponse({ ok: false, error: "Method not allowed" }, { status: 405, headers: getCustomerAccountCorsHeaders() });
}
