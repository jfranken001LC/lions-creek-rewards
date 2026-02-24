import crypto from "crypto";

export type CustomerSessionClaims = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  dest?: string;
  sid?: string;
  [key: string]: unknown;
};

export type CustomerSession = {
  shop: string;       // "store.myshopify.com"
  customerId: string; // numeric ID string
  claims: CustomerSessionClaims;
  token: string;
};

export class CustomerSessionError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 401, code = "UNAUTHORIZED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function base64UrlToBuffer(input: string): Buffer {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, "base64");
}

function safeJsonParse(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function timingSafeEqualString(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function normalizeShopFromDest(dest: string): string {
  const cleaned = dest.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return cleaned.split("/")[0];
}

export function customerIdFromSub(sub: string | undefined | null): string | null {
  if (!sub) return null;
  const m = String(sub).match(/Customer\/(\d+)$/);
  if (m?.[1]) return m[1];
  if (/^\d+$/.test(String(sub))) return String(sub);
  return null;
}

export function verifyCustomerSessionToken(token: string): CustomerSessionClaims {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    throw new CustomerSessionError("Missing SHOPIFY_API_SECRET env var", 500, "SERVER_MISCONFIG");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new CustomerSessionError("Invalid token format", 401, "BAD_TOKEN");

  const [headerB64, payloadB64, sigB64] = parts;
  const headerRaw = base64UrlToBuffer(headerB64).toString("utf8");
  const payloadRaw = base64UrlToBuffer(payloadB64).toString("utf8");

  const header = safeJsonParse(headerRaw);
  const payload = safeJsonParse(payloadRaw) as CustomerSessionClaims | null;

  if (!header || !payload) throw new CustomerSessionError("Invalid token JSON", 401, "BAD_TOKEN");
  if (String(header.alg).toUpperCase() !== "HS256") {
    throw new CustomerSessionError("Unsupported token alg", 401, "BAD_TOKEN");
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto
    .createHmac("sha256", apiSecret)
    .update(signingInput)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  if (!timingSafeEqualString(expectedSig, sigB64)) {
    throw new CustomerSessionError("Invalid token signature", 401, "BAD_TOKEN");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) {
    throw new CustomerSessionError("Token not yet valid", 401, "BAD_TOKEN");
  }
  if (typeof payload.exp === "number" && payload.exp < nowSec - 60) {
    throw new CustomerSessionError("Token expired", 401, "TOKEN_EXPIRED");
  }

  const apiKey = process.env.SHOPIFY_API_KEY;
  if (apiKey) {
    const aud = payload.aud;
    const ok = Array.isArray(aud) ? aud.includes(apiKey) : String(aud ?? "") === apiKey;
    if (!ok) throw new CustomerSessionError("Token audience mismatch", 401, "BAD_TOKEN");
  }

  return payload;
}

export async function requireCustomerSession(request: Request): Promise<CustomerSession> {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m?.[1]) throw new CustomerSessionError("Missing Authorization Bearer token", 401, "MISSING_TOKEN");

  const token = m[1].trim();
  const claims = verifyCustomerSessionToken(token);

  const dest = String(claims.dest ?? "");
  if (!dest) throw new CustomerSessionError("Token missing dest", 401, "BAD_TOKEN");

  const shop = normalizeShopFromDest(dest);
  if (!shop || !shop.includes(".")) throw new CustomerSessionError("Invalid dest/shop", 401, "BAD_TOKEN");

  const customerId = customerIdFromSub(String(claims.sub ?? ""));
  if (!customerId) throw new CustomerSessionError("Customer not logged in", 401, "NO_CUSTOMER");

  return { shop, customerId, claims, token };
}
