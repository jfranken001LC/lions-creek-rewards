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
