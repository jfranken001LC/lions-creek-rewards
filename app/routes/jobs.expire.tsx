import { json, type ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { LedgerType, RedemptionStatus } from "@prisma/client";

const DEFAULT_REDEMPTION_TTL_HOURS = 72;
const DEFAULT_POINTS_INACTIVITY_DAYS = 365;

/**
 * Cron/job endpoint to:
 *  - expire unused reward discount codes (72h TTL)
 *  - expire points after 12 months of inactivity
 *
 * Security: requires X-Job-Secret header matching JOB_SECRET env var.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const secret = request.headers.get("X-Job-Secret") ?? "";
  const expected = process.env.JOB_SECRET ?? "";

  if (!expected || secret !== expected) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const jobKey = `expire-${now.toISOString().slice(0, 10)}`; // YYYY-MM-DD

  // Ensure once per day (best-effort).
  const acquired = await tryAcquireJobLock(jobKey);
  if (!acquired) {
    return json({ ok: true, skipped: true, message: "Already executed today." });
  }

  const ttlHours = Number(process.env.REDEMPTION_CODE_TTL_HOURS ?? DEFAULT_REDEMPTION_TTL_HOURS);
  const inactivityDays = Number(process.env.POINTS_INACTIVITY_DAYS ?? DEFAULT_POINTS_INACTIVITY_DAYS);

  const shops = await listShops();

  let expiredRedemptions = 0;
  let expiredPointBalances = 0;

  for (const shop of shops) {
    expiredRedemptions += await expireRedemptionsForShop(shop, now, ttlHours);
    expiredPointBalances += await expirePointsForShop(shop, now, inactivityDays, jobKey);
  }

  return json({ ok: true, expiredRedemptions, expiredPointBalances });
};

async function listShops() {
  const [a, b] = await Promise.all([
    db.redemption.findMany({ distinct: ["shop"], select: { shop: true } }),
    db.customerPointsBalance.findMany({ distinct: ["shop"], select: { shop: true } }),
  ]);
  return Array.from(new Set([...a.map((x) => x.shop), ...b.map((x) => x.shop)])).filter(Boolean);
}

async function tryAcquireJobLock(name: string) {
  try {
    await db.jobLock.create({ data: { key: name } as any });
    return true;
  } catch {
    return false;
  }
}

async function expireRedemptionsForShop(shop: string, now: Date, ttlHours: number) {
  const cutoff = new Date(now.getTime() - ttlHours * 60 * 60 * 1000);

  const candidates = await db.redemption.findMany({
    where: {
      shop,
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      OR: [{ expiresAt: { lt: now } }, { expiresAt: null, issuedAt: { lt: cutoff } }],
    },
    select: { id: true, discountNodeId: true },
    take: 500,
  });

  const token = await getOfflineAccessToken(shop);
  let count = 0;

  for (const r of candidates) {
    try {
      if (token && r.discountNodeId) await deactivateDiscountCode(shop, token, r.discountNodeId);

      await db.redemption.update({
        where: { id: r.id },
        data: { status: RedemptionStatus.EXPIRED, expiredAt: now } as any,
      });

      count++;
    } catch (e) {
      console.error("expireRedemptionsForShop error:", shop, r.id, e);
    }
  }

  return count;
}

async function expirePointsForShop(shop: string, now: Date, inactivityDays: number, jobKey: string) {
  const cutoff = new Date(now.getTime() - inactivityDays * 24 * 60 * 60 * 1000);

  const targets = await db.customerPointsBalance.findMany({
    where: { shop, balance: { gt: 0 }, expiredAt: null, lastActivityAt: { lt: cutoff } },
    select: { customerId: true, balance: true },
    take: 1000,
  });

  let expired = 0;
  for (const t of targets) {
    const delta = -t.balance;
    const sourceId = `${t.customerId}:${jobKey}`;

    try {
      await db.$transaction(async (tx) => {
        await tx.pointsLedger.create({
          data: {
            shop,
            customerId: t.customerId,
            type: LedgerType.EXPIRE,
            delta,
            source: "EXPIRY",
            sourceId,
            description: `Expired ${t.balance} point(s) after ${inactivityDays} days of inactivity.`,
          },
        });

        await tx.customerPointsBalance.update({
          where: { shop_customerId: { shop, customerId: t.customerId } },
          data: { balance: 0, expiredAt: now },
        });
      });

      expired++;
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (msg.includes("Unique constraint failed") || msg.includes("UNIQUE constraint failed")) continue;
      console.error("expirePointsForShop error:", shop, t.customerId, e);
    }
  }

  return expired;
}

async function getOfflineAccessToken(shop: string) {
  const offlineId = `offline_${shop}`;
  const session = await db.session.findUnique({ where: { id: offlineId }, select: { accessToken: true } });
  return session?.accessToken ?? null;
}

async function deactivateDiscountCode(shop: string, accessToken: string, discountNodeId: string) {
  const mutation = `#graphql
    mutation DeactivateDiscount($id: ID!) {
      discountCodeDeactivate(id: $id) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }
  `;

  const resp = await adminGraphql(shop, accessToken, mutation, { id: discountNodeId });
  const errors = resp?.data?.discountCodeDeactivate?.userErrors ?? [];
  if (errors.length) throw new Error(`discountCodeDeactivate userErrors: ${JSON.stringify(errors)}`);
}

async function adminGraphql(shop: string, accessToken: string, query: string, variables?: any) {
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-01";
  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  const jsonResp = JSON.parse(text);

  if (!res.ok || jsonResp.errors) {
    throw new Error(`Shopify GraphQL error (${res.status}): ${JSON.stringify(jsonResp.errors ?? jsonResp)}`);
  }
  return jsonResp;
}
