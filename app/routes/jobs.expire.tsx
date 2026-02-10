import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";

/**
 * POST /jobs/expire
 * Protect with X-Job-Token: process.env.JOB_TOKEN
 */
export const loader = async (_args: LoaderFunctionArgs) => {
  return new Response("ok", { status: 200 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("ok", { status: 200 });

  const token = request.headers.get("X-Job-Token") ?? "";
  if (!process.env.JOB_TOKEN || token !== process.env.JOB_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const jobKey = `expire:${new Date().toISOString().slice(0, 10)}`;

  // Idempotent job lock
  try {
    await db.jobLock.create({
      data: { key: jobKey, createdAt: new Date() },
    });
  } catch {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: "already-ran" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

  const targets = await db.customerPointsBalance.findMany({
    where: {
      balance: { gt: 0 },
      lastActivityAt: { lt: cutoff },
    },
    take: 5000,
  });

  let expiredCount = 0;

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

    expiredCount += 1;
  }

  return new Response(JSON.stringify({ ok: true, jobKey, expiredCount }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
