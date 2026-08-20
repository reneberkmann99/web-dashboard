-- CreateEnum
CREATE TYPE "LifecycleScopeType" AS ENUM ('CONDITION', 'NODE', 'WORKLOAD');

-- CreateEnum
CREATE TYPE "MaintenanceNotificationBehavior" AS ENUM ('SUPPRESS', 'KEEP');

-- CreateEnum
CREATE TYPE "NotificationDestinationType" AS ENUM ('WEBHOOK');

-- CreateEnum
CREATE TYPE "NotificationEventType" AS ENUM ('CONDITION_OPENED', 'SEVERITY_ESCALATED', 'CONDITION_RESOLVED', 'SILENCE_EXPIRED_STILL_ACTIVE', 'TEST_NOTIFICATION');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'SUPPRESSED');

-- CreateTable
CREATE TABLE "AttentionAcknowledgement" (
    "id" TEXT NOT NULL,
    "attentionStateId" TEXT NOT NULL,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "clearedById" TEXT,
    "clearedAt" TIMESTAMP(3),
    "clearedReason" TEXT,

    CONSTRAINT "AttentionAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttentionSilence" (
    "id" TEXT NOT NULL,
    "scope" "LifecycleScopeType" NOT NULL,
    "attentionStateId" TEXT,
    "nodeId" TEXT,
    "workloadId" TEXT,
    "createdById" TEXT,
    "reason" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "expiredNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttentionSilence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceWindow" (
    "id" TEXT NOT NULL,
    "scope" "LifecycleScopeType" NOT NULL,
    "nodeId" TEXT,
    "workloadId" TEXT,
    "createdById" TEXT,
    "reason" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "notificationBehavior" "MaintenanceNotificationBehavior" NOT NULL DEFAULT 'SUPPRESS',
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "startedRecordedAt" TIMESTAMP(3),
    "endedProcessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDestination" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "NotificationDestinationType" NOT NULL DEFAULT 'WEBHOOK',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "urlEncrypted" TEXT NOT NULL,
    "urlMasked" TEXT NOT NULL,
    "authHeaderEncrypted" TEXT,
    "signingSecretEncrypted" TEXT NOT NULL,
    "minSeverity" "AttentionSeverity" NOT NULL DEFAULT 'WARNING',
    "eventTypes" "NotificationEventType"[],
    "scopeNodeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopeWorkloadIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveryStatus" "NotificationDeliveryStatus",
    "lastDeliveryAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDestination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationEvent" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "type" "NotificationEventType" NOT NULL,
    "attentionStateId" TEXT,
    "severity" "AttentionSeverity",
    "resourceType" TEXT,
    "resourceId" TEXT,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "notificationEventId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "httpStatus" INTEGER,
    "error" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "isManualRetry" BOOLEAN NOT NULL DEFAULT false,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttentionAcknowledgement_attentionStateId_idx" ON "AttentionAcknowledgement"("attentionStateId");

-- CreateIndex
CREATE INDEX "AttentionAcknowledgement_attentionStateId_clearedAt_idx" ON "AttentionAcknowledgement"("attentionStateId", "clearedAt");

-- Preserve the full acknowledgement history while allowing only one current
-- acknowledgement for a condition. Prisma cannot express partial indexes.
CREATE UNIQUE INDEX "AttentionAcknowledgement_one_active_per_state"
ON "AttentionAcknowledgement"("attentionStateId") WHERE "clearedAt" IS NULL;

-- CreateIndex
CREATE INDEX "AttentionSilence_attentionStateId_idx" ON "AttentionSilence"("attentionStateId");

-- CreateIndex
CREATE INDEX "AttentionSilence_nodeId_idx" ON "AttentionSilence"("nodeId");

-- CreateIndex
CREATE INDEX "AttentionSilence_workloadId_idx" ON "AttentionSilence"("workloadId");

-- CreateIndex
CREATE INDEX "AttentionSilence_endsAt_idx" ON "AttentionSilence"("endsAt");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_nodeId_idx" ON "MaintenanceWindow"("nodeId");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_workloadId_idx" ON "MaintenanceWindow"("workloadId");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_startsAt_endsAt_idx" ON "MaintenanceWindow"("startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "NotificationDestination_enabled_idx" ON "NotificationDestination"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationEvent_dedupeKey_key" ON "NotificationEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationEvent_attentionStateId_idx" ON "NotificationEvent"("attentionStateId");

-- CreateIndex
CREATE INDEX "NotificationEvent_occurredAt_idx" ON "NotificationEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_destinationId_status_idx" ON "NotificationDelivery"("destinationId", "status");

-- CreateIndex
CREATE INDEX "NotificationDelivery_notificationEventId_idx" ON "NotificationDelivery"("notificationEventId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_nextRetryAt_idx" ON "NotificationDelivery"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_notificationEventId_destinationId_atte_key" ON "NotificationDelivery"("notificationEventId", "destinationId", "attemptNumber");

-- Scope integrity: exactly one target must match the declared scope. These
-- checks prevent malformed lifecycle rows even if a future caller bypasses
-- the service validation layer.
ALTER TABLE "AttentionSilence" ADD CONSTRAINT "AttentionSilence_scope_target_check" CHECK (
  ("scope" = 'CONDITION' AND "attentionStateId" IS NOT NULL AND "nodeId" IS NULL AND "workloadId" IS NULL) OR
  ("scope" = 'NODE' AND "attentionStateId" IS NULL AND "nodeId" IS NOT NULL AND "workloadId" IS NULL) OR
  ("scope" = 'WORKLOAD' AND "attentionStateId" IS NULL AND "nodeId" IS NULL AND "workloadId" IS NOT NULL)
);
ALTER TABLE "AttentionSilence" ADD CONSTRAINT "AttentionSilence_time_check" CHECK ("startsAt" < "endsAt");
ALTER TABLE "MaintenanceWindow" ADD CONSTRAINT "MaintenanceWindow_scope_target_check" CHECK (
  ("scope" = 'NODE' AND "nodeId" IS NOT NULL AND "workloadId" IS NULL) OR
  ("scope" = 'WORKLOAD' AND "nodeId" IS NULL AND "workloadId" IS NOT NULL)
);
ALTER TABLE "MaintenanceWindow" ADD CONSTRAINT "MaintenanceWindow_time_check" CHECK ("startsAt" < "endsAt");
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_attempt_check" CHECK ("attemptNumber" > 0);

-- AddForeignKey
ALTER TABLE "AttentionAcknowledgement" ADD CONSTRAINT "AttentionAcknowledgement_attentionStateId_fkey" FOREIGN KEY ("attentionStateId") REFERENCES "AttentionState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionAcknowledgement" ADD CONSTRAINT "AttentionAcknowledgement_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionAcknowledgement" ADD CONSTRAINT "AttentionAcknowledgement_clearedById_fkey" FOREIGN KEY ("clearedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionSilence" ADD CONSTRAINT "AttentionSilence_attentionStateId_fkey" FOREIGN KEY ("attentionStateId") REFERENCES "AttentionState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionSilence" ADD CONSTRAINT "AttentionSilence_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionSilence" ADD CONSTRAINT "AttentionSilence_workloadId_fkey" FOREIGN KEY ("workloadId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionSilence" ADD CONSTRAINT "AttentionSilence_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionSilence" ADD CONSTRAINT "AttentionSilence_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWindow" ADD CONSTRAINT "MaintenanceWindow_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWindow" ADD CONSTRAINT "MaintenanceWindow_workloadId_fkey" FOREIGN KEY ("workloadId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWindow" ADD CONSTRAINT "MaintenanceWindow_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWindow" ADD CONSTRAINT "MaintenanceWindow_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDestination" ADD CONSTRAINT "NotificationDestination_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_attentionStateId_fkey" FOREIGN KEY ("attentionStateId") REFERENCES "AttentionState"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationEventId_fkey" FOREIGN KEY ("notificationEventId") REFERENCES "NotificationEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "NotificationDestination"("id") ON DELETE CASCADE ON UPDATE CASCADE;
