-- Lions Creek Rewards (v1.1) tables for SQLite
-- Prisma migration: 20260210193000_loyalty_tables

PRAGMA foreign_keys=OFF;

-- CreateTable
CREATE TABLE "ShopSettings" (
  "shop" TEXT NOT NULL PRIMARY KEY,
  "earnRate" INTEGER NOT NULL DEFAULT 1,
  "redemptionMinOrder" INTEGER NOT NULL DEFAULT 0,
  "excludedCustomerTags" TEXT,
  "includeProductTags" TEXT,
  "excludeProductTags" TEXT,
  "redemptionSteps" TEXT,
  "redemptionValueMap" TEXT,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CustomerPointsBalance" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "balance" INTEGER NOT NULL DEFAULT 0,
  "lifetimeEarned" INTEGER NOT NULL DEFAULT 0,
  "lifetimeRedeemed" INTEGER NOT NULL DEFAULT 0,
  "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiredAt" DATETIME
);

-- CreateTable
CREATE TABLE "PointsLedger" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "type" TEXT NOT NULL CHECK ("type" IN ('EARN','REVERSAL','REDEEM','ADJUST','EXPIRE')),
  "delta" INTEGER NOT NULL,
  "source" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OrderPointsSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "eligibleNetMerchandise" REAL NOT NULL DEFAULT 0,
  "pointsAwarded" INTEGER NOT NULL DEFAULT 0,
  "pointsReversedToDate" INTEGER NOT NULL DEFAULT 0,
  "paidAt" DATETIME NOT NULL,
  "cancelledAt" DATETIME,
  "currency" TEXT NOT NULL DEFAULT 'CAD'
);

-- CreateTable
CREATE TABLE "Redemption" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "pointsSpent" INTEGER NOT NULL,
  "value" INTEGER NOT NULL,
  "code" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ISSUED' CHECK ("status" IN ('ISSUED','APPLIED','VOID','EXPIRED')),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "issuedAt" DATETIME,
  "appliedAt" DATETIME,
  "expiresAt" DATETIME
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WebhookError" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "error" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PrivacyEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "JobLock" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex / Unique constraints
CREATE UNIQUE INDEX "CustomerPointsBalance_shop_customerId_key" ON "CustomerPointsBalance"("shop","customerId");
CREATE INDEX "CustomerPointsBalance_shop_customerId_idx" ON "CustomerPointsBalance"("shop","customerId");

CREATE INDEX "PointsLedger_shop_customerId_createdAt_idx" ON "PointsLedger"("shop","customerId","createdAt");
CREATE UNIQUE INDEX "PointsLedger_ledger_dedupe_key" ON "PointsLedger"("shop","customerId","type","source","sourceId");

CREATE UNIQUE INDEX "OrderPointsSnapshot_shop_orderId_key" ON "OrderPointsSnapshot"("shop","orderId");
CREATE INDEX "OrderPointsSnapshot_shop_customerId_idx" ON "OrderPointsSnapshot"("shop","customerId");

CREATE UNIQUE INDEX "Redemption_shop_code_key" ON "Redemption"("shop","code");
CREATE INDEX "Redemption_shop_customerId_createdAt_idx" ON "Redemption"("shop","customerId","createdAt");

CREATE UNIQUE INDEX "WebhookEvent_shop_webhookId_key" ON "WebhookEvent"("shop","webhookId");
CREATE INDEX "WebhookEvent_shop_topic_receivedAt_idx" ON "WebhookEvent"("shop","topic","receivedAt");

CREATE INDEX "WebhookError_shop_createdAt_idx" ON "WebhookError"("shop","createdAt");
CREATE INDEX "PrivacyEvent_shop_createdAt_idx" ON "PrivacyEvent"("shop","createdAt");

PRAGMA foreign_keys=ON;
