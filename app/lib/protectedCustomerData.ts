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

export type ProtectedCustomerDataFormatted = {
  isProtectedCustomerDataIssue: boolean;
  title?: string;
  short?: string;
  help?: string;
  docsUrl: string;
};

function stringify(x: unknown): string {
  try {
    return typeof x === "string" ? x : JSON.stringify(x);
  } catch {
    return String(x);
  }
}

/**
 * Collect error messages from:
 * - a string
 * - an array of strings
 * - common Shopify GraphQL client error shapes
 */
function collectMessages(err: any): string[] {
  const msgs: string[] = [];
  if (!err) return msgs;

  // Common case in your routes: pass string[]
  if (Array.isArray(err)) {
    for (const e of err) {
      if (typeof e === "string") msgs.push(e);
      else if (e?.message) msgs.push(String(e.message));
      else if (e) msgs.push(stringify(e));
    }
    return msgs.filter(Boolean);
  }

  if (typeof err === "string") return [err];

  if (typeof err.message === "string") msgs.push(err.message);

  // Common Shopify GraphQL error shapes:
  // - err.response?.errors
  // - err.response?.body?.errors
  // - err.body?.errors
  // - err.errors
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
  context?: { operation?: string },
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

/**
 * ✅ This is the missing export expected by app/routes/app.customers.tsx
 *
 * Accepts either:
 * - string[] (your route passes GraphQL errors as strings)
 * - unknown error object (for other call sites)
 *
 * Returns a merchant-friendly message bundle usable by both UI + API route responses.
 */
export function formatProtectedCustomerDataError(errorsOrErr: unknown): ProtectedCustomerDataFormatted {
  const messages = collectMessages(errorsOrErr as any);
  const isPCD = isProtectedCustomerDataError(messages.length ? messages : errorsOrErr);

  if (!isPCD) {
    return {
      isProtectedCustomerDataIssue: false,
      docsUrl: PROTECTED_CUSTOMER_DATA_DOC_URL,
    };
  }

  const raw = messages[0] ?? "This app is not approved to access customer data.";
  const title = "Customer data access blocked by Shopify (Protected Customer Data)";
  const short = "Shopify is restricting customer name/email fields for this app.";
  const help =
    `Shopify returned a Protected Customer Data error:\n` +
    `• ${raw}\n\n` +
    `What this means:\n` +
    `• Public / App Store apps must be approved for Protected Customer Data to access Customer object or certain fields (name/email).\n\n` +
    `Workarounds:\n` +
    `• Use numeric Customer ID / GID lookups where possible (less likely to be blocked than free-text search).\n` +
    `• If you need name/email search in-admin, request Protected Customer Data approval in the Shopify Partner/Dev Dashboard.\n\n` +
    `Docs: ${PROTECTED_CUSTOMER_DATA_DOC_URL}`;

  return {
    isProtectedCustomerDataIssue: true,
    title,
    short,
    help,
    docsUrl: PROTECTED_CUSTOMER_DATA_DOC_URL,
  };
}
