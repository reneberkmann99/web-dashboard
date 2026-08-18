-- Activity page filters by client; grants/assignments/operations already
-- recorded client ids in metadata, but a first-class column is cleaner.
ALTER TABLE "AuditLog" ADD COLUMN "clientAccountId" TEXT;
CREATE INDEX "AuditLog_clientAccountId_idx" ON "AuditLog"("clientAccountId");
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_clientAccountId_fkey" FOREIGN KEY ("clientAccountId") REFERENCES "ClientAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill from existing metadata where recorded.
UPDATE "AuditLog" SET "clientAccountId" = (metadata->>'clientAccountId')::text
WHERE "clientAccountId" IS NULL AND metadata ? 'clientAccountId' AND (metadata->>'clientAccountId') ~ '^c[0-9a-z]{20,}$';
