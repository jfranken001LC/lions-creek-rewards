import { data, Form, Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const outcome = String(url.searchParams.get("outcome") ?? "").trim();
  const topic = String(url.searchParams.get("topic") ?? "").trim();

  const where: any = { shop };
  if (outcome) where.outcome = outcome;
  if (topic) where.topic = topic;

  const [events, errors] = await Promise.all([
    db.webhookEvent.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      take: 200,
    }),
    db.webhookError.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return data({
    shop,
    filters: { outcome, topic },
    events: events.map((e) => ({
      id: e.id,
      webhookId: e.webhookId,
      topic: e.topic,
      resourceId: e.resourceId,
      receivedAt: e.receivedAt.toISOString(),
      outcome: String((e as any).outcome ?? "RECEIVED"),
      outcomeCode: (e as any).outcomeCode ?? null,
      outcomeMessage: (e as any).outcomeMessage ?? null,
      processedAt: (e as any).processedAt ? new Date((e as any).processedAt).toISOString() : null,
    })),
    errors: errors.map((er) => ({
      id: er.id,
      webhookId: er.webhookId,
      topic: er.topic,
      error: er.error,
      createdAt: er.createdAt.toISOString(),
    })),
  });
};

export default function WebhooksAdmin() {
  const { shop, filters, events, errors } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: 18, maxWidth: 980 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>Webhook logs</h1>
        <Link to="/app" style={{ opacity: 0.8 }}>
          ← Back
        </Link>
      </div>
      <div style={{ opacity: 0.7, marginTop: 6, marginBottom: 14 }}>Shop: {shop}</div>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Filters</h2>
        <Form method="get" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
          <label>
            Outcome
            <select name="outcome" defaultValue={filters.outcome}>
              <option value="">(any)</option>
              <option value="RECEIVED">RECEIVED</option>
              <option value="PROCESSED">PROCESSED</option>
              <option value="SKIPPED">SKIPPED</option>
              <option value="FAILED">FAILED</option>
            </select>
          </label>
          <label>
            Topic (exact)
            <input name="topic" placeholder="orders/paid" defaultValue={filters.topic} />
          </label>
          <button type="submit">Apply</button>
        </Form>
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
          This satisfies FR-6.3 “admin-visible webhook processing logs”. Payload replay is not enabled (payloads are not stored).
        </div>
      </section>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Recent webhook events (max 200)</h2>
        <div style={{ maxHeight: 420, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>When</th>
                <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>Topic</th>
                <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>Resource</th>
                <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} style={{ borderTop: "1px solid #f2f2f2" }}>
                  <td style={{ padding: "6px 0", fontSize: 12 }}>{new Date(e.receivedAt).toLocaleString()}</td>
                  <td style={{ padding: "6px 0", fontSize: 12 }}>
                    <code>{e.topic}</code>
                  </td>
                  <td style={{ padding: "6px 0", fontSize: 12 }}>{e.resourceId}</td>
                  <td style={{ padding: "6px 0", fontSize: 12 }}>
                    <strong>{e.outcome}</strong>
                    {e.outcomeCode ? <span style={{ opacity: 0.8 }}> ({e.outcomeCode})</span> : null}
                    {e.outcomeMessage ? <div style={{ opacity: 0.75 }}>{e.outcomeMessage}</div> : null}
                  </td>
                </tr>
              ))}
              {events.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: 10, opacity: 0.7 }}>
                    No events found for the current filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
        <h2 style={{ marginTop: 0 }}>Recent errors (max 50)</h2>
        <div style={{ maxHeight: 260, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>When</th>
                <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>Topic</th>
                <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>Webhook ID</th>
                <th style={{ textAlign: "left", fontSize: 12, opacity: 0.7, paddingBottom: 6 }}>Error</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((er) => (
                <tr key={er.id} style={{ borderTop: "1px solid #f2f2f2" }}>
                  <td style={{ padding: "6px 0", fontSize: 12 }}>{new Date(er.createdAt).toLocaleString()}</td>
                  <td style={{ padding: "6px 0", fontSize: 12 }}>
                    <code>{er.topic}</code>
                  </td>
                  <td style={{ padding: "6px 0", fontSize: 12 }}>{er.webhookId}</td>
                  <td style={{ padding: "6px 0", fontSize: 12, whiteSpace: "pre-wrap" }}>{er.error}</td>
                </tr>
              ))}
              {errors.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: 10, opacity: 0.7 }}>
                    No errors logged.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
