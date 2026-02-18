import { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { assertJobAuth } from "../lib/jobAuth.server";

// @prisma/client is CommonJS. Vite SSR may rewrite named imports, so keep it as a default import.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// IMPORTANT: Prisma schema defines `LedgerType` (not `PointsLedgerType`). Using a non-existent
// export can build, but will crash the server at runtime in ESM mode.
import prismaPkg from "@prisma/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { LedgerType, RedemptionStatus } = prismaPkg as any;

export async function action({ request }: ActionFunctionArgs) {
  assertJobAuth(request);

  // Expire redemptions that are past expiresAt and still ISSUED, and restore points.
  const now = new Date();

  const expiring = await db.redemption.findMany({
    where: {
      status: RedemptionStatus.ISSUED,
      expiresAt: { lt: now },
    },
    take: 250,
  });

  let expiredCount = 0;

  for (const r of expiring) {
    // Mark redemption expired (idempotent: only ISSUED -> EXPIRED).
    const updated = await db.redemption.updateMany({
      where: { id: r.id, status: RedemptionStatus.ISSUED },
      data: { status: RedemptionStatus.EXPIRED, updatedAt: new Date() },
    });

    if (updated.count !== 1) continue;

    // Restore points with a ledger entry; unique constraint prevents dupes.
    await db.pointsLedger.create({
      data: {
        shop: r.shop,
        customerId: r.customerId,
        // Restoring points because the redemption expired.
        // We record this as an ADJUSTMENT entry to avoid introducing a new enum value.
        type: LedgerType.ADJUSTMENT,
        delta: r.points,
        source: "REDEMPTION_EXPIRY",
        sourceId: r.id,
        notes: "Expiry restore",
      },
    });

    // Update balance (upsert).
    await db.customerPointsBalance.upsert({
      where: { shop_customerId: { shop: r.shop, customerId: r.customerId } },
      create: { shop: r.shop, customerId: r.customerId, balance: r.points },
      update: { balance: { increment: r.points } },
    });

    expiredCount++;
  }

  return Response.json({ ok: true, expiredCount });
}
