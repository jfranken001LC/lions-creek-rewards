import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";

type LedgerRow = {
  id: string;
  type: string;
  delta: number;
  description: string | null;
  createdAt: string;
  runningBalance: number;
};

function timingSafeEqual(a: Buffer, b: Buffer) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyAppProxyHmac(url: URL, apiSecret: string): boolean {
  const hmac = url.searchParams.get("hmac");
  if (!hmac || !apiSecret) return false;

  const pairs: string[] = [];
  const keys = Array.from(url.searchParams.keys())
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort();

  for (const k of keys) {
    const values = url.searchParams.getAll(k);
    for (const v of values) pairs.push(`${k}=${v}`);
  }

  const message = pairs.join("&");
  const digest = crypto.createHmac("sha256", apiSecret).update(message).digest("hex");
  return timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmac, "utf8"));
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";

  const shop = (url.searchParams.get("shop") ?? "").toLowerCase();
  const customerId = url.searchParams.get("logged_in_customer_id") ?? "";

  if (!verifyAppProxyHmac(url, apiSecret)) return data({ ok: false, error: "Unauthorized (bad HMAC)" }, { status: 401 });
  if (!shop || !customerId) return data({ ok: false, error: "Missing shop or customer" }, { status: 400 });

  const settings = await db.shopSettings.findUnique({ where: { shop } }).catch(() => null);

  const balanceRow = await db.customerPointsBalance.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });

  const balance = balanceRow?.balance ?? 0;
  const lastActivityAt = balanceRow?.lastActivityAt ?? null;
  const estimatedExpiryAt = lastActivityAt ? addMonths(lastActivityAt, 12) : null;

  const ledgerRaw = await db.pointsLedger.findMany({
    where: { shop, customerId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // running balances from current (descending)
  let running = balance;
  const ledger: LedgerRow[] = ledgerRaw.map((r) => {
    const row: LedgerRow = {
      id: r.id,
      type: String(r.type),
      delta: r.delta,
      description: r.description ?? null,
      createdAt: r.createdAt.toISOString(),
      runningBalance: running,
    };
    running = running - r.delta;
    return row;
  });

  const redemptionsRaw = await db.redemption.findMany({
    where: { shop, customerId },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const redemptions = redemptionsRaw.map((r: any) => ({
    id: r.id,
    points: Number(r.points ?? r.pointsSpent ?? 0),
    value: Number(r.value ?? 0),
    code: String(r.code ?? ""),
    status: String(r.status ?? ""),
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
    expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
    appliedAt: r.appliedAt ? new Date(r.appliedAt).toISOString() : null,
    consumedAt: r.consumedAt ? new Date(r.consumedAt).toISOString() : null,
    consumedOrderId: r.consumedOrderId ? String(r.consumedOrderId) : null,
    expiredAt: r.expiredAt ? new Date(r.expiredAt).toISOString() : null,
  }));

  const activeRedemption = redemptions.find((r) => r.status === "ISSUED") ?? null;

  return data({
    ok: true,
    shop,
    customerId,
    balance,
    lifetimeEarned: balanceRow?.lifetimeEarned ?? 0,
    lifetimeRedeemed: balanceRow?.lifetimeRedeemed ?? 0,
    lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
    estimatedExpiryAt: estimatedExpiryAt ? estimatedExpiryAt.toISOString() : null,
    redemptionMinOrder: settings?.redemptionMinOrder ?? 0,
    redemptionSteps: (settings as any)?.redemptionSteps ?? [500, 1000],
    redemptionValueMap: (settings as any)?.redemptionValueMap ?? { "500": 10, "1000": 20 },
    ledger,
    redemptions,
    activeRedemption,
  });
};
