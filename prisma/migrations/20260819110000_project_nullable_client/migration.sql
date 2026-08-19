-- Phase 4: a Project (workload) may have NO client — an "internal"/unassigned
-- workload visible only to ADMIN until an AccessGrant exists. Ownership/ACL
-- is always resolved through AccessGrant, never inferred from this column.
--
-- Drop the old (clientAccountId, slug) uniqueness (required client) and the
-- CASCADE-on-client-delete FK; replace with SET NULL (client deactivation is
-- soft anyway via isActive, but a hard client delete must not cascade-delete
-- workloads) and a per-node slug uniqueness that works whether or not the
-- workload has a client.
ALTER TABLE "Project" ALTER COLUMN "clientAccountId" DROP NOT NULL;

ALTER TABLE "Project" DROP CONSTRAINT "Project_clientAccountId_fkey";
ALTER TABLE "Project" ADD CONSTRAINT "Project_clientAccountId_fkey"
  FOREIGN KEY ("clientAccountId") REFERENCES "ClientAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX "Project_clientAccountId_slug_key";
CREATE UNIQUE INDEX "Project_nodeId_slug_key" ON "Project"("nodeId", "slug");
CREATE INDEX "Project_clientAccountId_idx" ON "Project"("clientAccountId");
