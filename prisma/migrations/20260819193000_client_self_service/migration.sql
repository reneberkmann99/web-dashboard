-- Client self-service (Phase 7): node allowlist + per-revision security policy.

-- CreateEnum
CREATE TYPE "DeploymentPolicy" AS ENUM ('ADMIN', 'CLIENT');

-- AlterTable: every revision records the policy it was authored/validated under;
-- deploy-time re-analysis must use the same policy.
ALTER TABLE "DeploymentRevision" ADD COLUMN "policy" "DeploymentPolicy" NOT NULL DEFAULT 'ADMIN';

-- CreateTable
CREATE TABLE "ClientNodeAccess" (
    "id" TEXT NOT NULL,
    "clientAccountId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientNodeAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientNodeAccess_clientAccountId_nodeId_key" ON "ClientNodeAccess"("clientAccountId", "nodeId");

-- CreateIndex
CREATE INDEX "ClientNodeAccess_clientAccountId_idx" ON "ClientNodeAccess"("clientAccountId");

-- CreateIndex
CREATE INDEX "ClientNodeAccess_nodeId_idx" ON "ClientNodeAccess"("nodeId");

-- AddForeignKey
ALTER TABLE "ClientNodeAccess" ADD CONSTRAINT "ClientNodeAccess_clientAccountId_fkey" FOREIGN KEY ("clientAccountId") REFERENCES "ClientAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientNodeAccess" ADD CONSTRAINT "ClientNodeAccess_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
