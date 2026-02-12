// app/lib/protectedCustomerData.ts
type ProtectedCustomerDataFormat = {
  isProtectedCustomerDataIssue: boolean;
  title?: string;
  short?: string;
  help?: string;
};

export function formatProtectedCustomerDataError(messages: string[]): ProtectedCustomerDataFormat {
  const m = (messages || []).join("\n");

  const isCustomerObjectBlocked =
    /not approved to access the Customer object/i.test(m) ||
    /protected customer data/i.test(m);

  const isFieldBlocked =
    /not approved to use the .* field/i.test(m) ||
    /not approved to use the .* field/i.test(m);

  const isProtected = isCustomerObjectBlocked || isFieldBlocked;

  if (!isProtected) return { isProtectedCustomerDataIssue: false };

  // Make the guidance explicit and actionable.
  const help =
    [
      "Shopify is blocking Customer data for this app (Protected Customer Data policy).",
      "",
      "To enable customer search by name/email for a PUBLIC (App Store) app:",
      "1) Partner Dashboard → Apps → (this app) → API access requests",
      "2) Request access under “Protected customer data access”",
      "   - Select Protected customer data (Level 1)",
      "   - For name/email search, also request Name and Email fields (Level 2)",
      "3) Complete data protection details and (for live stores) submit for review",
      "4) Reinstall / re-auth the app so the token reflects the approval",
      "",
      "Workaround while blocked:",
      "- Use numeric Customer ID (or Customer GID) from Shopify Admin URL to look up balances/ledger.",
    ].join("\n");

  return {
    isProtectedCustomerDataIssue: true,
    title: "Customer search blocked: app not approved for Protected Customer Data",
    short: "Customer name/email fields may be redacted until Protected Customer Data access is approved.",
    help,
  };
}
