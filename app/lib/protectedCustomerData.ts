/**
 * Shopify Protected Customer Data helper
 *
 * Purpose:
 * - Detect the “not approved to access Customer object/fields” GraphQL errors
 * - Return a consistent, merchant-friendly error payload that UI/routes can show
 *
 * NOTE:
 * This is NOT fixable in code alone. The app must be granted Protected Customer Data access
 * in Partner/Dev Dashboard for the relevant resources/fields.
 */
export const PROTECTED_CUSTOMER_DATA_DOC_URL =
  "https://shopify.dev/docs/apps/launch/protected-customer-data";

export type ProtectedCustomerDataFailure = {
  ok: false;
  code: "PROTECTED_CUSTOMER_DATA";
  error: string;
  docsUrl: string;
};

function stringify(x: unknown): string {
  try {
    return typeof x === "string" ? x : JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function collectMessages(err: any): string[] {
  const msgs: string[] = [];

  if (!err) return msgs;

  if (typeof err.message === "string") msgs.push(err.message);

  // Common Shopify GraphQL error shapes:
  // - err.response?.errors
  // - err.response?.body?.errors
  // - err.body?.errors
  const candidates = [
    err?.response?.errors,
    err?.response?.body?.errors,
    err?.body?.errors,
    err?.errors,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) {
      for (const e of c) {
        const m = (e && (e.message || e?.extensions?.message)) ?? null;
        if (typeof m === "string") msgs.push(m);
        else if (m) msgs.push(stringify(m));
      }
    }
  }

  return msgs.filter(Boolean);
}

export function isProtectedCustomerDataError(err: unknown): boolean {
  const messages = collectMessages(err as any);
  const haystack = messages.join(" | ").toLowerCase();

  // Shopify’s canonical phrasing for this family of failures:
  // “This app is not approved to access the Customer object…”
  // “This app is not approved to use the <field> field…”
  // Sometimes also mentions “protected customer data”.
  return (
    haystack.includes("not approved to access the customer object") ||
    haystack.includes("not approved to use") ||
    haystack.includes("protected customer data") ||
    haystack.includes("/customer_data")
  );
}

export function toProtectedCustomerDataFailure(
  err: unknown,
  context?: { operation?: string }
): ProtectedCustomerDataFailure | null {
  if (!isProtectedCustomerDataError(err)) return null;

  const operation = context?.operation ? `${context.operation}: ` : "";
  const raw = collectMessages(err as any)[0] ?? "Protected customer data access denied.";

  return {
    ok: false,
    code: "PROTECTED_CUSTOMER_DATA",
    error:
      `⚠️ ${operation}Customer search failed: ${raw}\n\n` +
      `This usually means the app is missing Protected Customer Data access approval (even if scopes like read_customers are present).\n` +
      `See: ${PROTECTED_CUSTOMER_DATA_DOC_URL}`,
    docsUrl: PROTECTED_CUSTOMER_DATA_DOC_URL,
  };
}
