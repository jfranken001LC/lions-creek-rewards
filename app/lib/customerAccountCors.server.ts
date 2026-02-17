export const CUSTOMER_ACCOUNT_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,Idempotency-Key,X-Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};

export function getCustomerAccountCorsHeaders(): Record<string, string> {
  return { ...CUSTOMER_ACCOUNT_CORS_HEADERS };
}

export function withCustomerAccountCors(response: Response) {
  for (const [k, v] of Object.entries(CUSTOMER_ACCOUNT_CORS_HEADERS)) {
    response.headers.set(k, v);
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function customerAccountPreflight() {
  return new Response(null, { status: 204, headers: CUSTOMER_ACCOUNT_CORS_HEADERS });
}
