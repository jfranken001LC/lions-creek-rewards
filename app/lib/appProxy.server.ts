import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shopify App Proxy HMAC verification.
 *
 * Shopify forwards storefront requests to your app (App Proxy) and signs the
 * query string with an `hmac` using your app secret.
 *
 * Algorithm (Shopify docs):
 * - Take all query params EXCEPT `hmac` and `signature`
 * - Sort keys lexicographically
 * - Join as `key=value` pairs with `&`
 * - HMAC-SHA256 with SHOPIFY_API_SECRET
 */

export type AppProxyContext = {
  shop: string;
  /** Numeric customer id as a string (e.g., "1234567890") */
  customerId: string;
};

function buildMessage(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete("hmac");
  params.delete("signature");

  const keys = Array.from(params.keys()).sort();
  return keys
    .map((k) => {
      const v = params.get(k) ?? "";
      return `${k}=${v}`;
    })
    .join("&");
}

export function verifyAppProxyHmac(url: URL, secret: string): boolean {
  const received = url.searchParams.get("hmac") ?? "";
  if (!received) return false;

  const msg = buildMessage(url);
  const computed = createHmac("sha256", secret).update(msg).digest("hex");

  try {
    const a = Buffer.from(received, "utf8");
    const b = Buffer.from(computed, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Extract and verify App Proxy context.
 * Throws a Response (401/400) on failure.
 */
export function requireAppProxyContext(request: Request): AppProxyContext {
  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (!secret) {
    throw new Response("Missing SHOPIFY_API_SECRET", { status: 500 });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop")?.trim() || "";
  const customerId =
    url.searchParams.get("logged_in_customer_id")?.trim() ||
    url.searchParams.get("customer_id")?.trim() ||
    "";

  if (!shop) throw new Response("Missing shop", { status: 400 });
  if (!customerId) throw new Response("Customer not logged in", { status: 401 });

  const ok = verifyAppProxyHmac(url, secret);
  if (!ok) throw new Response("Invalid App Proxy signature", { status: 401 });

  return { shop, customerId };
}
