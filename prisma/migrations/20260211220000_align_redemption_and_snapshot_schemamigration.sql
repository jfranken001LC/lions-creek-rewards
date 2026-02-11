/*
  Migration: Align Prisma schema with implemented redemption & order snapshot flows.

  - Redemption
    - pointsSpent -> points
    - add: idemKey, discountNodeId, consumedAt, consumedOrderId, expiredAt, cancelledAt
    - expand status enum to include CONSUMED, CANCELLED
    - preserve createdAt/issuedAt/appliedAt/expiresAt

  - OrderPointsSnapshot
    - add: orderName, discountCodesJson
    - preserve existing: cancelledAt, currency
*/

PRAGMA foreign_keys=OFF;

-- Redefine Redemption (SQLite requires table rebuild for drop/rename/change constraints)
CREATE TABLE "new_Redemption" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "points" INTEGER NOT NULL,
  "value" INTEGER NOT NULL,
  "code" TEXT NOT NULL,
  "discountNodeId" TEXT,
  "idemKey" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ISSUED' CHECK ("status" IN ('ISSUED','APPLIED','CONSUMED','VOID','EXPIRED','CANCELLED')),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "issuedAt" DATETIME,
  "appliedAt" DATETIME,
  "expiresAt" DATETIME,
  "expiredAt" DATETIME,
  "consumedAt" DATETIME,
  "consumedOrderId" TEXT,
  "voidedAt" DATETIME,
  "cancelledAt" DATETIME
);

INSERT INTO "new_Redemption" (
  "id","shop","customerId","points","value","code","status",
  "createdAt","issuedAt","appliedAt","expiresAt"
)
SELECT
  "id","shop","customerId","pointsSpent","value","code","status",
  "createdAt","issuedAt","appliedAt","expiresAt"
FROM "Redemption";

DROP TABLE "Redemption";
ALTER TABLE "new_Redemption" RENAME TO "Redemption";

CREATE UNIQUE INDEX "shop_code" ON "Redemption"("shop","code");
CREATE UNIQUE INDEX "shop_customerId_idemKey" ON "Redemption"("shop","customerId","idemKey");
CREATE INDEX "Redemption_shop_customerId_createdAt_idx" ON "Redemption"("shop","customerId","createdAt");
CREATE INDEX "Redemption_shop_status_createdAt_idx" ON "Redemption"("shop","status","createdAt");

-- Redefine OrderPointsSnapshot (add audit fields, preserve currency)
CREATE TABLE "new_OrderPointsSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderName" TEXT,
  "customerId" TEXT NOT NULL,
  "eligibleNetMerchandise" REAL NOT NULL DEFAULT 0,
  "pointsAwarded" INTEGER NOT NULL DEFAULT 0,
  "pointsReversedToDate" INTEGER NOT NULL DEFAULT 0,
  "paidAt" DATETIME NOT NULL,
  "cancelledAt" DATETIME,
  "currency" TEXT NOT NULL DEFAULT 'CAD',
  "discountCodesJson" JSONB
);

INSERT INTO "new_OrderPointsSnapshot" (
  "id","shop","orderId","customerId",
  "eligibleNetMerchandise","pointsAwarded","pointsReversedToDate",
  "paidAt","cancelledAt","currency"
)
SELECT
  "id","shop","orderId","customerId",
  "eligibleNetMerchandise","pointsAwarded","pointsReversedToDate",
  "paidAt","cancelledAt","currency"
FROM "OrderPointsSnapshot";

DROP TABLE "OrderPointsSnapshot";
ALTER TABLE "new_OrderPointsSnapshot" RENAME TO "OrderPointsSnapshot";

CREATE UNIQUE INDEX "shop_orderId" ON "OrderPointsSnapshot"("shop","orderId");
CREATE INDEX "OrderPointsSnapshot_shop_customerId_idx" ON "OrderPointsSnapshot"("shop","customerId");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
