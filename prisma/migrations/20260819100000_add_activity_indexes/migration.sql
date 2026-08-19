-- Composite indexes for the activity feed: client-scoped recent activity and
-- result-filtered recent activity are the two dominant query shapes now that
-- the Activity page does server-side filtering + pagination.
CREATE INDEX "AuditLog_clientAccountId_createdAt_idx" ON "AuditLog"("clientAccountId", "createdAt");
CREATE INDEX "AuditLog_result_createdAt_idx" ON "AuditLog"("result", "createdAt");
