/*
  Warnings:

  - You are about to alter the column `excludeProductTags` on the `ShopSettings` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `excludedCustomerTags` on the `ShopSettings` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `includeProductTags` on the `ShopSettings` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `redemptionSteps` on the `ShopSettings` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `redemptionValueMap` on the `ShopSettings` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "earnRate" INTEGER NOT NULL DEFAULT 1,
    "redemptionMinOrder" INTEGER NOT NULL DEFAULT 0,
    "excludedCustomerTags" JSONB,
    "includeProductTags" JSONB,
    "excludeProductTags" JSONB,
    "redemptionSteps" JSONB,
    "redemptionValueMap" JSONB,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ShopSettings" ("earnRate", "excludeProductTags", "excludedCustomerTags", "includeProductTags", "redemptionMinOrder", "redemptionSteps", "redemptionValueMap", "shop", "updatedAt") SELECT "earnRate", "excludeProductTags", "excludedCustomerTags", "includeProductTags", "redemptionMinOrder", "redemptionSteps", "redemptionValueMap", "shop", "updatedAt" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
CREATE TABLE "new_WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL DEFAULT 'RECEIVED',
    "outcomeCode" TEXT,
    "outcomeMessage" TEXT,
    "processedAt" DATETIME
);
INSERT INTO "new_WebhookEvent" ("id", "receivedAt", "resourceId", "shop", "topic", "webhookId") SELECT "id", "receivedAt", "resourceId", "shop", "topic", "webhookId" FROM "WebhookEvent";
DROP TABLE "WebhookEvent";
ALTER TABLE "new_WebhookEvent" RENAME TO "WebhookEvent";
CREATE INDEX "WebhookEvent_shop_topic_receivedAt_idx" ON "WebhookEvent"("shop", "topic", "receivedAt");
CREATE UNIQUE INDEX "WebhookEvent_shop_webhookId_key" ON "WebhookEvent"("shop", "webhookId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- RedefineIndex
DROP INDEX "PointsLedger_ledger_dedupe_key";
CREATE UNIQUE INDEX "PointsLedger_shop_customerId_type_source_sourceId_key" ON "PointsLedger"("shop", "customerId", "type", "source", "sourceId");
