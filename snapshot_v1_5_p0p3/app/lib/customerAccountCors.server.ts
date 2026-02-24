// app/lib/customerAccountCors.server.ts

const SHOPIFY_APP_URL = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  const normalized = origin.replace(/\/$/, "");

  // Customer Account UI extensions and Customer Account pages can be served from several
  // Shopify-owned domains and can involve redirects/custom URLs depending on store configuration.
  // These endpoints are still protected by a short-lived Customer Account session token (Bearer),
  // so it is safe (and much more robust) to allow any HTTPS origin here.
  if (normalized.startsWith("https://")) return true;

  // Local tooling convenience.
  if (normalized.startsWith("http://localhost") || normalized.startsWith("http://127.0.0.1")) return true;

  // Your app's own origin (useful for local testing/tools)
  if (SHOPIFY_APP_URL && normalized === SHOPIFY_APP_URL) return true;

  // Customer account UI extensions are hosted on this origin
  if (normalized === "https://extensions.shopifycdn.com") return true;

  // Allow Shopify-owned origins that may call your public customer endpoints
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
