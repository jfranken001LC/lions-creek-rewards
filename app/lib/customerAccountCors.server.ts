// app/lib/customerAccountCors.server.ts

const SHOPIFY_APP_URL = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  const normalized = origin.replace(/\/$/, "");

  if (SHOPIFY_APP_URL && normalized === SHOPIFY_APP_URL) return true;

  if (/^https:\/\/([a-z0-9][a-z0-9-]*\.)?myshopify\.com$/i.test(normalized)) return true;
  if (/^https:\/\/([a-z0-9][a-z0-9-]*\.)?shopify\.com$/i.test(normalized)) return true;

  return false;
}

function corsHeadersFor(request: Request): Headers {
  const origin = request.headers.get("Origin") || "";

  const headers = new Headers();
  if (origin && isAllowedOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }

  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "86400");

  return headers;
}

export function withCustomerAccountCors(request: Request, response: Response): Response {
  const headers = corsHeadersFor(request);

  const next = new Headers(response.headers);
  headers.forEach((v, k) => next.set(k, v));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: next,
  });
}

export function customerAccountPreflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeadersFor(request) });
}

// Back-compat aliases (some routes import these names).
export const applyCustomerAccountCors = withCustomerAccountCors;
export const preflightCustomerAccountCors = customerAccountPreflight;
