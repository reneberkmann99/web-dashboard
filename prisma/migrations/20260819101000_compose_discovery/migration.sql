-- Compose workload discovery: mark Projects as MANUAL or COMPOSE, record the
-- Docker Compose project name on COMPOSE projects, and record the Compose
-- project/service a container came from on the discovered Container rows.
CREATE TYPE "ProjectSource" AS ENUM ('MANUAL', 'COMPOSE');

ALTER TABLE "Project" ADD COLUMN "source" "ProjectSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "Project" ADD COLUMN "composeProject" TEXT;

-- COMPOSE projects are unique per (node, composeProject); MANUAL projects have
-- a NULL composeProject and Postgres treats NULLs as distinct, so they are
-- unaffected by this constraint.
CREATE UNIQUE INDEX "Project_nodeId_composeProject_key" ON "Project"("nodeId", "composeProject");
CREATE INDEX "Project_source_idx" ON "Project"("source");

ALTER TABLE "Container" ADD COLUMN "composeProject" TEXT;
ALTER TABLE "Container" ADD COLUMN "composeService" TEXT;
