/*
  Warnings:

  - A unique constraint covering the columns `[shop,type,source,sourceId]` on the table `PointsLedger` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "PointsLedger_shop_type_source_sourceId_key" ON "PointsLedger"("shop", "type", "source", "sourceId");

-- CreateIndex
CREATE INDEX "WebhookEvent_shop_outcome_receivedAt_idx" ON "WebhookEvent"("shop", "outcome", "receivedAt");
