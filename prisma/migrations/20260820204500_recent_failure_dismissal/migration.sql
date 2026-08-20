-- Operator dismissal of a grouped Recent Failure (UI-only; never touches
-- audit/activity, the operation record, or active attention state).
CREATE TABLE "RecentFailureDismissal" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "dismissedBy" TEXT,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecentFailureDismissal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecentFailureDismissal_key_key" ON "RecentFailureDismissal"("key");
CREATE INDEX "RecentFailureDismissal_dismissedAt_idx" ON "RecentFailureDismissal"("dismissedAt");
