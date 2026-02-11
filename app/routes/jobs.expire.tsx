import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";

/**
 * POST /jobs/expire
 * Header: X-Job-Token = process.env.JOB_TOKEN
 *
 * This job does:
 *  1) Expire unused redemption codes (ISSUED/APPLIED -> EXPIRED) past TTL,
 *     and deactivate OR delete the Shopify discount node (best-effort).
 *  2) Expire points after 12 months of inactivity.
 *
 * Env:
 *  - JOB_TOKEN=...
 *  - REDEMPTION_CODE_TTL_DAYS=7
 *  - REDEMPTION_EXPIRE_BATCH=250
 *  - REDEMPTION_DELETE_ON_EXPIRE=true   (optional; default false)
 */

export const loader = async (_args: LoaderFunctionArgs) => {
  return new Response("ok", { status: 200 });
};

async function getOfflineAccessToken(shop: string): Promise<string | null> {
  const id = `offline_${shop}`;
  const s = await db.session.findUnique({ where: { id } }).catch(() => null);
  return s?.accessToken ?? null;
}

async function shopifyGraphql(shop: string, query: string, variables: any) {
  const token = await getOfflineAccessToken(shop);
  if (!token) throw new Error(`Missing offline access token for shop ${shop}. Reinstall/re-auth the app.`);

  const endpoint = `https://${shop}/admin/api/2026-01/graphql.json`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Shopify GraphQL failed (${resp.status}): ${t}`);
  }

  const json = await resp.json().catch(() => null);
  if (json?.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json?.data;
}

async function deactivateDiscountNode(shop: string, discountNodeId: string) {
  const mutation = `
    mutation Deactivate($id: ID!) {
      discountCodeDeactivate(id: $id) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphql(shop, mutation, { id: discountNodeId });
  const res = data?.discountCodeDeactivate;
  const errs: any[] = res?.userErrors ?? [];
  if (errs.length) throw new Error(`discountCodeDeactivate userErrors: ${JSON.stringify(errs)}`);
  return String(res?.codeDiscountNode?.id ?? "");
}

async function deleteDiscountNode(shop: string, discountNodeId: string) {
  const mutation = `
    mutation Delete($id: ID!) {
      discountCodeDelete(id: $id) {
        deletedCodeDiscountId
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphql(shop, mutation, { id: discountNodeId });
  const res = data?.discountCodeDelete;
  const errs: any[] = res?.userErrors ?? [];
  if (errs.length) throw new Error(`discountCodeDelete userErrors: ${JSON.stringify(errs)}`);
  return String(res?.deletedCodeDiscountId ?? "");
}

function envBool(v: string | undefined, defaultValue = false) {
  if (v == null) return defaultValue;
  const s = v.trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(s);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("ok", { status: 200 });

  const token = request.headers.get("X-Job-Token") ?? "";
  if (!process.env.JOB_TOKEN || token !== process.env.JOB_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const jobKey = `expire:${new Date().toISOString().slice(0, 10)}`;

  // Idempotent job lock (per day)
  try {
    await db.jobLock.create({ data: { key: jobKey, createdAt: new Date() } });
  } catch {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: "already-ran" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ttlDays = Number(process.env.REDEMPTION_CODE_TTL_DAYS ?? "7") || 7;
  const codeCutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
  const maxCodesPerRun = Number(process.env.REDEMPTION_EXPIRE_BATCH ?? "250") || 250;
  const deleteOnExpire = envBool(process.env.REDEMPTION_DELETE_ON_EXPIRE, false);

  // ------------------------------------------------------------
  // 1) Expire unused redemption codes
  // ------------------------------------------------------------
  const now = new Date();
  const codesToExpire = await db.redemption.findMany({
    where: {
      status: { in: ["ISSUED", "APPLIED"] } as any,
      OR: [{ expiresAt: { lt: now } }, { createdAt: { lt: codeCutoff } }],
    },
    orderBy: { createdAt: "asc" },
    take: maxCodesPerRun,
    select: {
      id: true,
      shop: true,
      code: true,
      discountNodeId: true,
      status: true,
    },
  });

  let redemptionExpiredCount = 0;
  let redemptionDeactivatedCount = 0;
  let redemptionDeletedCount = 0;

  const cleanupErrors: Array<{ id: string; shop: string; mode: string; error: string }> = [];

  for (const r of codesToExpire) {
    // Attempt Shopify cleanup (best-effort)
    if (r.discountNodeId) {
      if (deleteOnExpire) {
        try {
          const deletedId = await deleteDiscountNode(r.shop, r.discountNodeId);
          if (deletedId) redemptionDeletedCount += 1;
        } catch (e: any) {
          cleanupErrors.push({
            id: r.id,
            shop: r.shop,
            mode: "delete",
            error: String(e?.message ?? e),
          });
          // Fall back to deactivate if delete fails
          try {
            const deactivatedId = await deactivateDiscountNode(r.shop, r.discountNodeId);
            if (deactivatedId) redemptionDeactivatedCount += 1;
          } catch (e2: any) {
            cleanupErrors.push({
              id: r.id,
              shop: r.shop,
              mode: "deactivate-fallback",
              error: String(e2?.message ?? e2),
            });
          }
        }
      } else {
        try {
          const deactivatedId = await deactivateDiscountNode(r.shop, r.discountNodeId);
          if (deactivatedId) redemptionDeactivatedCount += 1;
        } catch (e: any) {
          cleanupErrors.push({
            id: r.id,
            shop: r.shop,
            mode: "deactivate",
            error: String(e?.message ?? e),
          });
        }
      }
    }

    // Mark redemption expired in DB
    await db.redemption.update({
      where: { id: r.id },
      data: {
        status: "EXPIRED",
        expiredAt: new Date(),
      } as any,
    });

    redemptionExpiredCount += 1;
  }

  // ------------------------------------------------------------
  // 2) Expire points after 12 months inactivity
  // ------------------------------------------------------------
  const pointsCutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

  const targets = await db.customerPointsBalance.findMany({
    where: {
      balance: { gt: 0 },
      lastActivityAt: { lt: pointsCutoff },
    },
    take: 5000,
  });

  let pointsExpiredCount = 0;

  for (const t of targets) {
    const pointsToExpire = t.balance;
    if (pointsToExpire <= 0) continue;

    await db.$transaction(async (tx) => {
      await tx.pointsLedger.create({
        data: {
          shop: t.shop,
          customerId: t.customerId,
          type: "EXPIRE",
          delta: -pointsToExpire,
          source: "EXPIRY",
          sourceId: jobKey,
          description: "Expired points due to 12 months inactivity",
          createdAt: new Date(),
        },
      });

      await tx.customerPointsBalance.update({
        where: { shop_customerId: { shop: t.shop, customerId: t.customerId } },
        data: {
          balance: 0,
          expiredAt: new Date(),
        },
      });
    });

    pointsExpiredCount += 1;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      jobKey,
      redemption: {
        ttlDays,
        cutoffIso: codeCutoff.toISOString(),
        expireBatch: maxCodesPerRun,
        deleteOnExpire,
        expiredCount: redemptionExpiredCount,
        deactivatedCount: redemptionDeactivatedCount,
        deletedCount: redemptionDeletedCount,
        cleanupErrors,
      },
      points: {
        cutoffIso: pointsCutoff.toISOString(),
        expiredCount: pointsExpiredCount,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
