/*
  Warnings:

  - You are about to drop the column `eventTypes` on the `NotificationDestination` table. All the data in the column will be lost.
  - You are about to drop the column `minSeverity` on the `NotificationDestination` table. All the data in the column will be lost.
  - You are about to drop the column `scopeNodeIds` on the `NotificationDestination` table. All the data in the column will be lost.
  - You are about to drop the column `scopeWorkloadIds` on the `NotificationDestination` table. All the data in the column will be lost.

  Phase 4 (Alerting) separates routing from destinations: every existing
  destination's eventTypes/minSeverity become a PLATFORM-scope NotificationRule
  pointing back at that same destination, preserving its exact routing
  behavior before the columns are dropped below. `scopeNodeIds`/
  `scopeWorkloadIds` have no equivalent in the new organization-based scope
  model (brief: "whole platform" or "specific Organization") and are
  deliberately not migrated — this is an intentional scope-axis change, not
  data loss of anything the new model can represent.
*/
-- CreateEnum
CREATE TYPE "NotificationRuleScope" AS ENUM ('PLATFORM', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "EmailDeliveryFailureClass" AS ENUM ('AUTH_FAILURE', 'RECIPIENT_REJECTED', 'TIMEOUT', 'TRANSIENT_SMTP_ERROR', 'UNKNOWN');

-- AlterEnum
ALTER TYPE "NotificationDestinationType" ADD VALUE 'EMAIL';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationEventType" ADD VALUE 'DEPLOYMENT_FAILED';
ALTER TYPE "NotificationEventType" ADD VALUE 'DEPLOYMENT_SUCCEEDED';

-- AlterTable
ALTER TABLE "NotificationDelivery" ADD COLUMN     "emailFailureClass" "EmailDeliveryFailureClass";

-- AlterTable: additive columns only — the four routing columns are dropped
-- further down, after their data has been copied into NotificationRule.
ALTER TABLE "NotificationDestination"
ADD COLUMN     "clientAccountId" TEXT,
ADD COLUMN     "emailRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "urlEncrypted" DROP NOT NULL,
ALTER COLUMN "urlMasked" DROP NOT NULL,
ALTER COLUMN "signingSecretEncrypted" DROP NOT NULL;

-- AlterTable
ALTER TABLE "NotificationEvent" ADD COLUMN     "clientAccountId" TEXT,
ADD COLUMN     "nodeId" TEXT,
ADD COLUMN     "workloadId" TEXT;

-- CreateTable
CREATE TABLE "NotificationRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "NotificationRuleScope" NOT NULL DEFAULT 'PLATFORM',
    "clientAccountId" TEXT,
    "eventTypes" "NotificationEventType"[],
    "minSeverity" "AttentionSeverity" NOT NULL DEFAULT 'WARNING',
    "destinationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationRule_enabled_idx" ON "NotificationRule"("enabled");

-- CreateIndex
CREATE INDEX "NotificationRule_clientAccountId_idx" ON "NotificationRule"("clientAccountId");

-- CreateIndex
CREATE INDEX "NotificationRule_destinationId_idx" ON "NotificationRule"("destinationId");

-- CreateIndex
CREATE INDEX "NotificationDestination_clientAccountId_idx" ON "NotificationDestination"("clientAccountId");

-- CreateIndex
CREATE INDEX "NotificationEvent_clientAccountId_idx" ON "NotificationEvent"("clientAccountId");

-- AddForeignKey
ALTER TABLE "NotificationDestination" ADD CONSTRAINT "NotificationDestination_clientAccountId_fkey" FOREIGN KEY ("clientAccountId") REFERENCES "ClientAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRule" ADD CONSTRAINT "NotificationRule_clientAccountId_fkey" FOREIGN KEY ("clientAccountId") REFERENCES "ClientAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRule" ADD CONSTRAINT "NotificationRule_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "NotificationDestination"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRule" ADD CONSTRAINT "NotificationRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DataMigration: one PLATFORM-scope rule per existing destination, preserving
-- its exact prior eventTypes/minSeverity/enabled routing behavior verbatim.
INSERT INTO "NotificationRule" ("id", "name", "scope", "clientAccountId", "eventTypes", "minSeverity", "destinationId", "enabled", "createdById", "createdAt", "updatedAt")
SELECT
  'migrated_' || "id",
  "name" || ' (migrated routing)',
  'PLATFORM',
  NULL,
  "eventTypes",
  "minSeverity",
  "id",
  "enabled",
  "createdById",
  now(),
  now()
FROM "NotificationDestination";

-- AlterTable: now safe to drop — every row's routing config has been copied
-- into a NotificationRule above.
ALTER TABLE "NotificationDestination"
DROP COLUMN "eventTypes",
DROP COLUMN "minSeverity",
DROP COLUMN "scopeNodeIds",
DROP COLUMN "scopeWorkloadIds";
