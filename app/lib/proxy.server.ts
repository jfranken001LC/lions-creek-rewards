// app/lib/proxy.server.ts
import { requireAppProxyContext } from "./appProxy.server";

export type VerifyAppProxyResult =
  | { ok: true; shop: string; customerId?: string }
  | { ok: false; error: string };

/**
 * Non-async on purpose:
 * - routes can call it sync OR with `await` (awaiting a non-Promise returns the value)
 * - avoids accidental Promise misuse
 */
export function verifyAppProxy(request: Request): VerifyAppProxyResult {
  try {
    const ctx = requireAppProxyContext(request);
    return { ok: true, shop: ctx.shop, customerId: ctx.customerId };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Invalid app proxy request",
    };
  }
}

/**
 * Extract the shop domain from a Customer Account session token `dest` claim.
 *
 * Typical examples:
 * - "https://lions-creek-dev-3.myshopify.com"
 * - "https://lions-creek-dev-3.myshopify.com/admin"
 * - "lions-creek-dev-3.myshopify.com"
 *
 * Sometimes (less common) Shopify uses:
 * - "https://admin.shopify.com/store/<store-handle>"
 * In that case we map it to "<store-handle>.myshopify.com".
 */
export function shopFromDest(dest: unknown): string {
  if (typeof dest !== "string") return "";
  const raw = dest.trim();
  if (!raw) return "";

  const tryParse = (s: string): URL | null => {
    try {
      return new URL(s);
    } catch {
      return null;
    }
  };

  let url = tryParse(raw) ?? tryParse(`https://${raw}`);
  if (!url) {
    // Last-resort regex fallback (handles weird strings)
    const m = raw.match(/https?:\/\/([^\/?#]+)/i);
    if (m?.[1]) return m[1].toLowerCase().split(":")[0];
    return "";
  }

  const host = (url.host || "").toLowerCase().split(":")[0];
  if (!host) return "";

  // Handle admin.shopify.com/store/<handle>
  if (host === "admin.shopify.com") {
    const m = url.pathname.match(/\/store\/([^\/]+)/i);
    if (m?.[1]) return `${m[1].toLowerCase()}.myshopify.com`;
  }

  return host;
}
