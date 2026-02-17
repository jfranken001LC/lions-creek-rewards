import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "react-router";
import { LedgerType, RedemptionStatus } from "@prisma/client";

import db from "../db.server";
import { isAuthorizedJobRequest } from "../lib/jobAuth.server";

const JOB_NAME = "expire";
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const INACTIVITY_DAYS = 365;

const noStoreHeaders = { "Cache-Control": "no-store" };

function iso(d: Date) {
  return d.toISOString();
}

async function tryAcquireLock(now: Date): Promise<boolean> {
  const lockedUntil = new Date(now.getTime() + LOCK_TTL_MS);

  return await db.$transaction(async (tx) => {
    const existing = await tx.jobLock.findUnique({ where: { name: JOB_NAME } });

    if (existing && existing.lockedUntil > now) {
      return false;
    }

    if (!existing) {
      await tx.jobLock.create({
        data: { name: JOB_NAME, lockedAt: now, lockedUntil },
      });
    } else {
      await tx.jobLock.update({
        where: { name: JOB_NAME },
        data: { lockedAt: now, lockedUntil },
      });
    }

    return true;
  });
}

async function releaseLock(now: Date) {
  try {
    await db.jobLock.update({
      where: { name: JOB_NAME },
      data: { lockedUntil: now },
    });
  } catch {
    // best-effort
  }
}

async function expireInactiveCustomers(now: Date) {
  const cutoff = new Date(now.getTime() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db.customerPointsBalance.findMany({
    where: {
      balance: { gt: 0 },
      expiredAt: null,
      lastActivityAt: { lt: cutoff },
    },
    select: {
      id: true,
      shop: true,
      customerId: true,
      balance: true,
      lastActivityAt: true,
    },
  });

  let expiredCount = 0;
  let pointsExpired = 0;

  for (const row of candidates) {
    const delta = -Math.abs(row.balance);
    const source = "INACTIVITY_EXPIRY";
    const sourceId = `EXP:${row.customerId}:${row.lastActivityAt.getTime()}`;

    try {
      await db.$transaction(async (tx) => {
        // If another run already expired it, skip.
        const current = await tx.customerPointsBalance.findUnique({
          where: { id: row.id },
          select: { balance: true, expiredAt: true },
        });

        if (!current || current.expiredAt || (current.balance ?? 0) <= 0) return;

        await tx.pointsLedger.create({
          data: {
            shop: row.shop,
            customerId: row.customerId,
            type: LedgerType.EXPIRY,
            delta: -Math.abs(current.balance),
            source,
            sourceId,
            description: `Expired ${current.balance} pts due to inactivity (>${INACTIVITY_DAYS} days).`,
          },
        });

        await tx.customerPointsBalance.update({
          where: { id: row.id },
          data: {
            balance: 0,
            expiredAt: now,
          },
        });

        expiredCount += 1;
        pointsExpired += Math.abs(current.balance);
      });
    } catch (e: any) {
      // Dedupe collisions or races should not fail the whole job.
      // You can add logging here if desired.
      const msg = String(e?.message ?? e);
      if (!msg.includes("Unique constraint") && !msg.includes("P2002")) {
        console.error("expireInactiveCustomers item error:", msg);
      }
    }
  }

  return {
    cutoff: iso(cutoff),
    expiredCount,
    pointsExpired,
  };
}

async function expireRedemptionsAndRestorePoints(now: Date) {
  const candidates = await db.redemption.findMany({
    where: {
      status: { in: [RedemptionStatus.ISSUED, RedemptionStatus.APPLIED] },
      expiresAt: { not: null, lte: now },
      expiredAt: null,
      consumedAt: null,
      voidedAt: null,
      cancelledAt: null,
    },
    select: {
      id: true,
      shop: true,
      customerId: true,
      points: true,
      value: true,
      code: true,
      expiresAt: true,
      status: true,
    },
    orderBy: { createdAt: "asc" },
  });

  let expiredCount = 0;
  let pointsRestored = 0;

  for (const r of candidates) {
    const source = "REDEMPTION_EXPIRED_UNUSED";

    try {
      await db.$transaction(async (tx) => {
        // Re-check in-tx for races
        const current = await tx.redemption.findUnique({
          where: { id: r.id },
          select: {
            status: true,
            expiredAt: true,
            consumedAt: true,
            voidedAt: true,
            cancelledAt: true,
            points: true,
            shop: true,
            customerId: true,
            code: true,
          },
        });

        if (
          !current ||
          current.expiredAt ||
          current.consumedAt ||
          current.voidedAt ||
          current.cancelledAt ||
          ![RedemptionStatus.ISSUED, RedemptionStatus.APPLIED].includes(current.status)
        ) {
          return;
        }

        const pts = current.points;

        // Mark redemption expired + restored
        await tx.redemption.update({
          where: { id: r.id },
          data: {
            status: RedemptionStatus.EXPIRED,
            expiredAt: now,
            restoredAt: now,
            restoreReason: "Expired unused code; points restored.",
          },
        });

        // Ledger restore entry (idempotent via sourceId = redemptionId)
        await tx.pointsLedger.create({
          data: {
            shop: current.shop,
            customerId: current.customerId,
            type: LedgerType.ADJUST,
            delta: pts,
            source,
            sourceId: r.id,
            description: `Restored ${pts} pts (expired unused reward code ${current.code}).`,
          },
        });

        // Update / upsert balance row
        const bal = await tx.customerPointsBalance.findUnique({
          where: { shop_customerId: { shop: current.shop, customerId: current.customerId } },
          select: { id: true, lifetimeRedeemed: true },
        });

        const nextLifetimeRedeemed = Math.max(0, (bal?.lifetimeRedeemed ?? 0) - pts);

        if (!bal) {
          await tx.customerPointsBalance.create({
            data: {
              shop: current.shop,
              customerId: current.customerId,
              balance: pts,
              lifetimeEarned: 0,
              lifetimeRedeemed: nextLifetimeRedeemed,
              lastActivityAt: now,
              expiredAt: null,
            },
          });
        } else {
          await tx.customerPointsBalance.update({
            where: { id: bal.id },
            data: {
              balance: { increment: pts },
              lifetimeRedeemed: nextLifetimeRedeemed,
              lastActivityAt: now,
              expiredAt: null,
            },
          });
        }

        expiredCount += 1;
        pointsRestored += pts;
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("Unique constraint") && !msg.includes("P2002")) {
        console.error("expireRedemptionsAndRestorePoints item error:", msg);
      }
    }
  }

  return {
    expiredCount,
    pointsRestored,
  };
}

async function run(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, { status: 405, headers: noStoreHeaders });
  }

  const auth = await isAuthorizedJobRequest(request, JOB_NAME);
  if (!auth.ok) {
    return json({ ok: false, error: auth.error }, { status: auth.status, headers: noStoreHeaders });
  }

  const startedAt = new Date();

  const acquired = await tryAcquireLock(startedAt);
  if (!acquired) {
    return json({ ok: false, error: "job_already_running" }, { status: 409, headers: noStoreHeaders });
  }

  try {
    const inactive = await expireInactiveCustomers(startedAt);
    const redemptions = await expireRedemptionsAndRestorePoints(startedAt);

    const finishedAt = new Date();
    await releaseLock(finishedAt);

    return json(
      {
        ok: true,
        job: JOB_NAME,
        startedAt: iso(startedAt),
        finishedAt: iso(finishedAt),
        inactive,
        redemptions,
      },
      { headers: noStoreHeaders }
    );
  } catch (err: any) {
    console.error("jobs.expire error:", err);
    const finishedAt = new Date();
    await releaseLock(finishedAt);

    return json({ ok: false, error: "server_error" }, { status: 500, headers: noStoreHeaders });
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  return run(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return run(request);
}
