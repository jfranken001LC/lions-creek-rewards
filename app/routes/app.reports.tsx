import { data, Form, Link, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

function ymd(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseDate(value: string, fallback: Date) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : fallback;
}

function perPointRateFromValueMap(valueMap: Record<string, number> | null | undefined): number {
  // Uses the best-known mapping ratio; v1 is 10/500 = 0.02
  if (!valueMap) return 0.02;
  let best = 0;
  for (const [k, v] of Object.entries(valueMap)) {
    const pts = Number(k);
    const dollars = Number(v);
    if (Number.isFinite(pts) && pts > 0 && Number.isFinite(dollars) && dollars > 0) {
      best = Math.max(best, dollars / pts);
    }
  }
  return best > 0 ? best : 0.02;
}

async function sumByType(shop: string, type: any, from: Date, to: Date) {
  const agg = await db.pointsLedger.aggregate({
    where: { shop, type, createdAt: { gte: from, lt: to } },
    _sum: { delta: true },
    _count: { _all: true },
  });
  return { sum: agg._sum.delta ?? 0, count: agg._count._all ?? 0 };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const now = new Date();
  const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const from = parseDate(String(url.searchParams.get("from") ?? ""), defaultFrom);
  const to = parseDate(String(url.searchParams.get("to") ?? ""), now);

  // normalize to [from, to) by setting end to next day if user picked a date-only
  const fromD = new Date(from);
  const toD = new Date(to);
  if (ymd(toD) === String(url.searchParams.get("to") ?? ymd(toD))) {
    // if the user passed YYYY-MM-DD, treat it as inclusive end date by adding 1 day
    toD.setDate(toD.getDate() + 1);
  }

  const settings = await db.shopSettings.findUnique({ where: { shop } }).catch(() => null);
  const valueMap = (settings as any)?.redemptionValueMap as Record<string, number> | undefined;
  const perPointRate = perPointRateFromValueMap(valueMap);

  const [earn, redeem, expire, reversal, adjust, balancesAgg, customerCount, redemptionCounts] = await Promise.all([
    sumByType(shop, "EARN", fromD, toD),
    sumByType(shop, "REDEEM", fromD, toD),
    sumByType(shop, "EXPIRE", fromD, toD),
    sumByType(shop, "REVERSAL", fromD, toD),
    sumByType(shop, "ADJUST", fromD, toD),
    db.customerPointsBalance.aggregate({ where: { shop }, _sum: { balance: true } }),
    db.customerPointsBalance.count({ where: { shop } }),
    db.redemption.groupBy({
      by: ["status"],
      where: { shop, createdAt: { gte: fromD, lt: toD } },
      _count: { _all: true },
    }).catch(() => [] as any[]),
  ]);

  const outstandingPoints = balancesAgg._sum.balance ?? 0;
  const liabilityCad = outstandingPoints * perPointRate;

  const redemptionByStatus: Record<string, number> = {};
  for (const r of redemptionCounts as any[]) {
    redemptionByStatus[String(r.status)] = Number(r._count?._all ?? 0);
  }

  return data({
    shop,
    from: ymd(fromD),
    to: ymd(new Date(toD.getTime() - 1)), // display inclusive date
    stats: {
      customerCount,
      outstandingPoints,
      liabilityCad,
      ledger: { earn, redeem, expire, reversal, adjust },
      redemptions: redemptionByStatus,
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");
  if (intent !== "downloadCsv") {
    return data({ ok: false, error: "Unknown action" }, { status: 400 });
  }

  const from = parseDate(String(form.get("from") ?? ""), new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const to = parseDate(String(form.get("to") ?? ""), new Date());

  const fromD = new Date(from);
  const toD = new Date(to);
  toD.setDate(toD.getDate() + 1); // inclusive end date

  const ledger = await db.pointsLedger.findMany({
    where: { shop, createdAt: { gte: fromD, lt: toD } },
    orderBy: { createdAt: "asc" },
    take: 20000,
  });

  // daily grouping
  const buckets: Record<string, { EARN: number; REDEEM: number; EXPIRE: number; REVERSAL: number; ADJUST: number }> = {};
  for (const row of ledger) {
    const day = ymd(row.createdAt);
    buckets[day] ||= { EARN: 0, REDEEM: 0, EXPIRE: 0, REVERSAL: 0, ADJUST: 0 };
    const t = String(row.type);
    if (t in buckets[day]) (buckets[day] as any)[t] += Number(row.delta ?? 0);
  }

  const lines: string[] = [];
  lines.push("date,earn_points,redeem_points,expire_points,reversal_points,adjust_points,net_points");

  const days = Object.keys(buckets).sort();
  for (const day of days) {
    const b = buckets[day];
    const net = b.EARN + b.REDEEM + b.EXPIRE + b.REVERSAL + b.ADJUST;
    lines.push([day, b.EARN, b.REDEEM, b.EXPIRE, b.REVERSAL, b.ADJUST, net].join(","));
  }

  const filename = `loyalty_report_${ymd(fromD)}_to_${ymd(new Date(toD.getTime() - 1))}.csv`;

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
};

export default function Reports() {
  const { shop, from, to, stats } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: 18, maxWidth: 980 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>Reports</h1>
        <Link to="/app" style={{ opacity: 0.8 }}>
          ← Back
        </Link>
      </div>
      <div style={{ opacity: 0.7, marginTop: 6, marginBottom: 14 }}>Shop: {shop}</div>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Date range</h2>
        <Form method="get" style={{ display: "flex", gap: 10, alignItems: "end" }}>
          <label>
            From
            <input type="date" name="from" defaultValue={from} />
          </label>
          <label>
            To (inclusive)
            <input type="date" name="to" defaultValue={to} />
          </label>
          <button type="submit">Run</button>
        </Form>

        <Form method="post" style={{ marginTop: 10 }}>
          <input type="hidden" name="_intent" value="downloadCsv" />
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          <button type="submit">Download CSV (daily summary)</button>
        </Form>
      </section>

      <section style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Program summary</h2>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Customers with balance rows</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{stats.customerCount}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Outstanding points</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{stats.outstandingPoints}</div>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
              Estimated liability (CAD): {stats.liabilityCad.toFixed(2)}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <h3 style={{ marginBottom: 6 }}>Ledger totals in range</h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              <tr style={{ borderTop: "1px solid #f1f1f1" }}>
                <td style={{ padding: "8px 0" }}>Earn</td>
                <td style={{ textAlign: "right" }}>
                  {stats.ledger.earn.sum} ({stats.ledger.earn.count} rows)
                </td>
              </tr>
              <tr style={{ borderTop: "1px solid #f1f1f1" }}>
                <td style={{ padding: "8px 0" }}>Redeem</td>
                <td style={{ textAlign: "right" }}>
                  {stats.ledger.redeem.sum} ({stats.ledger.redeem.count} rows)
                </td>
              </tr>
              <tr style={{ borderTop: "1px solid #f1f1f1" }}>
                <td style={{ padding: "8px 0" }}>Expire</td>
                <td style={{ textAlign: "right" }}>
                  {stats.ledger.expire.sum} ({stats.ledger.expire.count} rows)
                </td>
              </tr>
              <tr style={{ borderTop: "1px solid #f1f1f1" }}>
                <td style={{ padding: "8px 0" }}>Refund/Cancellation reversals</td>
                <td style={{ textAlign: "right" }}>
                  {stats.ledger.reversal.sum} ({stats.ledger.reversal.count} rows)
                </td>
              </tr>
              <tr style={{ borderTop: "1px solid #f1f1f1" }}>
                <td style={{ padding: "8px 0" }}>Admin adjustments</td>
                <td style={{ textAlign: "right" }}>
                  {stats.ledger.adjust.sum} ({stats.ledger.adjust.count} rows)
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 14 }}>
          <h3 style={{ marginBottom: 6 }}>Redemptions created in range</h3>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {Object.entries(stats.redemptions ?? {}).map(([k, v]) => (
              <div key={k} style={{ border: "1px solid #eee", borderRadius: 10, padding: "8px 10px" }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{k}</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{v}</div>
              </div>
            ))}
            {Object.keys(stats.redemptions ?? {}).length === 0 ? <div style={{ opacity: 0.7 }}>No redemptions.</div> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
