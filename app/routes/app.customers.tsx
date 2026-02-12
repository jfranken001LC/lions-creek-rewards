// app/routes/app.customers.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { formatProtectedCustomerDataError } from "../lib/protectedCustomerData";

/**
 * NOTE:
 * - "Search by name/email" requires Shopify Protected Customer Data approval for a Public/AppStore app.
 * - Without approval, Shopify returns HTTP 200 with GraphQL errors like:
 *   "This app is not approved to access the Customer object..."
 */

type CustomerHit = {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  tags?: string[] | null;
};

type ActionData =
  | { ok: true; mode: "id" | "query"; q: string; hits: CustomerHit[]; warnings?: string[] }
  | { ok: false; mode: "id" | "query"; q: string; error: string; help?: string; debug?: string };

function isNumeric(s: string) {
  return /^[0-9]+$/.test(s);
}

function toCustomerGid(q: string) {
  if (q.startsWith("gid://shopify/Customer/")) return q;
  if (isNumeric(q)) return `gid://shopify/Customer/${q}`;
  return null;
}

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const s = await db.session.findUnique({ where: { id } }).catch(() => null);
  return s?.accessToken ?? null;
}

async function shopifyGraphqlRaw(shop: string, query: string, variables: any) {
  const token = await getOfflineAccessToken(shop);
  if (!token) {
    return {
      data: null,
      errors: [{ message: "Missing offline access token for shop. Reinstall/re-auth the app." }],
    };
  }

  const endpoint = `https://${shop}/admin/api/2026-01/graphql.json`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });

  const text = await resp.text().catch(() => "");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // keep null
  }

  if (!resp.ok) {
    return {
      data: null,
      errors: [
        {
          message: `Shopify GraphQL failed: ${resp.status} ${resp.statusText}${text ? ` ${text}` : ""}`,
        },
      ],
    };
  }

  return { data: json?.data ?? null, errors: json?.errors ?? [] };
}

function buildCustomerSearchQuery(userQ: string) {
  const q = userQ.trim();

  // If it looks like an email, use email filter (still Level 2 field).
  if (q.includes("@")) return `email:${JSON.stringify(q)}`;

  // Otherwise, treat as name-ish input. Shopify customer search syntax supports "name:".
  // This still requires Protected Customer Data access for name fields in most public app contexts.
  return `name:${JSON.stringify(q)}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return data({ shop: session.shop });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");
  const q = String(form.get("q") ?? "").trim();

  if (intent !== "search") {
    return data<ActionData>({ ok: false, mode: "query", q, error: "Unknown intent." }, { status: 400 });
  }
  if (!q) {
    return data<ActionData>({ ok: false, mode: "query", q, error: "Enter a customer ID, GID, name, or email." }, { status: 400 });
  }

  // Mode 1: ID/GID lookup (best-effort fallback)
  const gid = toCustomerGid(q);
  if (gid) {
    const query = `
      query CustomerById($id: ID!) {
        customer(id: $id) {
          id
          tags
          # These are Level 2 fields; if unapproved they may be redacted/null and/or emit errors.
          email
          firstName
          lastName
        }
      }
    `;

    const res = await shopifyGraphqlRaw(shop, query, { id: gid });
    const errors = (res.errors ?? []).map((e: any) => String(e?.message ?? "")).filter(Boolean);

    if (!res.data?.customer) {
      const formatted = formatProtectedCustomerDataError(errors);
      return data<ActionData>(
        {
          ok: false,
          mode: "id",
          q,
          error: formatted.title ?? "Customer lookup failed.",
          help: formatted.help,
          debug: errors.length ? JSON.stringify(errors) : undefined,
        },
        { status: 400 },
      );
    }

    const c = res.data.customer;
    const warnings: string[] = [];
    const formatted = formatProtectedCustomerDataError(errors);
    if (formatted.isProtectedCustomerDataIssue) warnings.push(formatted.short ?? "Some customer fields may be redacted.");

    return data<ActionData>({
      ok: true,
      mode: "id",
      q,
      hits: [
        {
          id: String(c.id),
          tags: Array.isArray(c.tags) ? c.tags.map((t: any) => String(t)) : [],
          email: c.email ?? null,
          firstName: c.firstName ?? null,
          lastName: c.lastName ?? null,
        },
      ],
      warnings: warnings.length ? warnings : undefined,
    });
  }

  // Mode 2: name/email query search
  const searchQ = buildCustomerSearchQuery(q);
  const query = `
    query CustomersSearch($q: String!) {
      customers(first: 10, query: $q) {
        nodes {
          id
          tags
          # Level 2 fields (name/email). If unapproved, these can be null and may emit GraphQL errors.
          email
          firstName
          lastName
        }
      }
    }
  `;

  const res = await shopifyGraphqlRaw(shop, query, { q: searchQ });
  const errors = (res.errors ?? []).map((e: any) => String(e?.message ?? "")).filter(Boolean);
  const formatted = formatProtectedCustomerDataError(errors);

  const nodes: any[] = res.data?.customers?.nodes ?? [];
  if (!nodes.length) {
    // If protected customer data is blocking, show that explicitly.
    if (formatted.isProtectedCustomerDataIssue) {
      return data<ActionData>(
        {
          ok: false,
          mode: "query",
          q,
          error: formatted.title ?? "Customer search blocked by Shopify Protected Customer Data policy.",
          help: formatted.help,
          debug: errors.length ? JSON.stringify(errors) : undefined,
        },
        { status: 403 },
      );
    }

    return data<ActionData>({ ok: false, mode: "query", q, error: "No customers found (or data was redacted)." }, { status: 404 });
  }

  const hits: CustomerHit[] = nodes.map((c) => ({
    id: String(c.id),
    tags: Array.isArray(c.tags) ? c.tags.map((t: any) => String(t)) : [],
    email: c.email ?? null,
    firstName: c.firstName ?? null,
    lastName: c.lastName ?? null,
  }));

  const warnings: string[] = [];
  if (formatted.isProtectedCustomerDataIssue) warnings.push(formatted.short ?? "Some customer fields may be redacted.");

  return data<ActionData>({
    ok: true,
    mode: "query",
    q,
    hits,
    warnings: warnings.length ? warnings : undefined,
  });
};

export default function CustomersRoute() {
  const { shop } = useLoaderData<typeof loader>();
  const a = useActionData<ActionData>();

  return (
    <div style={{ padding: 16, maxWidth: 980 }}>
      <h1 style={{ marginBottom: 6 }}>Customer Search</h1>
      <div style={{ opacity: 0.7, marginBottom: 18 }}>Shop: {shop}</div>

      <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Search</h2>

        <Form method="post" style={{ display: "flex", gap: 8, alignItems: "end" }}>
          <input type="hidden" name="_intent" value="search" />
          <label style={{ flex: 1 }}>
            Customer ID / GID / Name / Email
            <input name="q" placeholder="1234567890 • gid://shopify/Customer/... • Jane Doe • jane@domain.com" />
          </label>
          <button type="submit">Search</button>
        </Form>

        <div style={{ marginTop: 10, opacity: 0.75 }}>
          <strong>Important:</strong> Name/email search can be blocked unless your public app is approved for Protected Customer Data.
          If blocked, use numeric Customer ID (from Shopify Admin URL) as a workaround.
        </div>
      </section>

      {a && !a.ok && (
        <section style={{ border: "1px solid #f2caca", background: "#fff5f5", borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ fontWeight: 700 }}>⚠️ {a.error}</div>
          {a.help && <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{a.help}</div>}
          {a.debug && (
            <details style={{ marginTop: 10 }}>
              <summary>Debug</summary>
              <pre style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{a.debug}</pre>
            </details>
          )}
        </section>
      )}

      {a && a.ok && (
        <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14 }}>
          <h2 style={{ marginTop: 0 }}>Results</h2>
          {a.warnings?.length ? (
            <div style={{ marginBottom: 10, opacity: 0.8 }}>
              {a.warnings.map((w, i) => (
                <div key={i}>⚠️ {w}</div>
              ))}
            </div>
          ) : null}

          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: "8px 6px" }}>Customer</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: "8px 6px" }}>Email</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: "8px 6px" }}>Tags</th>
              </tr>
            </thead>
            <tbody>
              {a.hits.map((h) => (
                <tr key={h.id}>
                  <td style={{ borderBottom: "1px solid #f4f4f4", padding: "8px 6px" }}>
                    <div style={{ fontFamily: "monospace", fontSize: 12 }}>{h.id}</div>
                    <div style={{ opacity: 0.8 }}>
                      {(h.firstName || h.lastName) ? `${h.firstName ?? ""} ${h.lastName ?? ""}`.trim() : <em>name redacted / unavailable</em>}
                    </div>
                  </td>
                  <td style={{ borderBottom: "1px solid #f4f4f4", padding: "8px 6px" }}>
                    {h.email ? h.email : <em>redacted / unavailable</em>}
                  </td>
                  <td style={{ borderBottom: "1px solid #f4f4f4", padding: "8px 6px" }}>
                    {h.tags?.length ? h.tags.join(", ") : <em>—</em>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
