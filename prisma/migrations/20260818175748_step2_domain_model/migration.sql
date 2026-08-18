-- CreateEnum
CREATE TYPE "OperationState" AS ENUM ('REQUESTED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'CLIENT_ADMIN';
ALTER TYPE "Role" ADD VALUE 'CLIENT_OPERATOR';
ALTER TYPE "Role" ADD VALUE 'CLIENT_VIEWER';

-- AlterTable
ALTER TABLE "ContainerAssignment" ADD COLUMN     "containerId" TEXT;

-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "agentVersion" TEXT,
ADD COLUMN     "dockerVersion" TEXT,
ADD COLUMN     "osInfo" JSONB,
ADD COLUMN     "systemInfo" JSONB;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ActivationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeEnrollmentToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "nodeId" TEXT,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeEnrollmentToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Container" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "dockerContainerId" TEXT NOT NULL,
    "dockerName" TEXT NOT NULL,
    "image" TEXT,
    "lastKnownStatus" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Container_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessGrant" (
    "id" TEXT NOT NULL,
    "clientAccountId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "projectId" TEXT,
    "containerId" TEXT,
    "allowedActions" TEXT[] DEFAULT ARRAY['start', 'stop', 'restart']::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "state" "OperationState" NOT NULL DEFAULT 'REQUESTED',
    "requestId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "actorRole" "Role",
    "clientAccountId" TEXT,
    "nodeId" TEXT NOT NULL,
    "dockerContainerId" TEXT NOT NULL,
    "containerId" TEXT,
    "targetAssignmentId" TEXT,
    "error" TEXT,
    "result" JSONB,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivationToken_userId_key" ON "ActivationToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivationToken_tokenHash_key" ON "ActivationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ActivationToken_expiresAt_idx" ON "ActivationToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NodeEnrollmentToken_tokenHash_key" ON "NodeEnrollmentToken"("tokenHash");

-- CreateIndex
CREATE INDEX "NodeEnrollmentToken_expiresAt_idx" ON "NodeEnrollmentToken"("expiresAt");

-- CreateIndex
CREATE INDEX "Container_nodeId_isActive_idx" ON "Container"("nodeId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Container_nodeId_dockerContainerId_key" ON "Container"("nodeId", "dockerContainerId");

-- CreateIndex
CREATE INDEX "AccessGrant_clientAccountId_isActive_idx" ON "AccessGrant"("clientAccountId", "isActive");

-- CreateIndex
CREATE INDEX "AccessGrant_nodeId_idx" ON "AccessGrant"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessGrant_clientAccountId_projectId_key" ON "AccessGrant"("clientAccountId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessGrant_clientAccountId_containerId_key" ON "AccessGrant"("clientAccountId", "containerId");

-- CreateIndex
CREATE INDEX "Operation_nodeId_state_idx" ON "Operation"("nodeId", "state");

-- CreateIndex
CREATE INDEX "Operation_dockerContainerId_state_idx" ON "Operation"("dockerContainerId", "state");

-- CreateIndex
CREATE INDEX "Operation_requestId_idx" ON "Operation"("requestId");

-- CreateIndex
CREATE INDEX "ContainerAssignment_containerId_idx" ON "ContainerAssignment"("containerId");

-- AddForeignKey
ALTER TABLE "ActivationToken" ADD CONSTRAINT "ActivationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeEnrollmentToken" ADD CONSTRAINT "NodeEnrollmentToken_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Container" ADD CONSTRAINT "Container_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContainerAssignment" ADD CONSTRAINT "ContainerAssignment_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_clientAccountId_fkey" FOREIGN KEY ("clientAccountId") REFERENCES "ClientAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_clientAccountId_fkey" FOREIGN KEY ("clientAccountId") REFERENCES "ClientAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- Backfill + integrity (hand-added on top of prisma-generated SQL)
-- ============================================================

-- Backfill Container inventory from existing assignments
INSERT INTO "Container" ("id", "nodeId", "dockerContainerId", "dockerName", "image", "lastKnownStatus", "firstSeenAt", "lastSeenAt", "isActive", "createdAt", "updatedAt")
SELECT 'c' || substr(md5(random()::text || a."id"), 1, 24), a."nodeId", a."dockerContainerId", a."dockerName", a."image", NULL, a."createdAt", a."updatedAt", a."isActive", a."createdAt", a."updatedAt"
FROM "ContainerAssignment" a
ON CONFLICT ("nodeId", "dockerContainerId") DO NOTHING;

-- Link existing assignments to their Container rows
UPDATE "ContainerAssignment" a
SET "containerId" = c."id"
FROM "Container" c
WHERE c."nodeId" = a."nodeId" AND c."dockerContainerId" = a."dockerContainerId" AND a."containerId" IS NULL;

-- Backfill AccessGrant rows from existing active assignments
INSERT INTO "AccessGrant" ("id", "clientAccountId", "nodeId", "containerId", "allowedActions", "isActive", "metadata", "createdAt", "updatedAt")
SELECT 'g' || substr(md5(random()::text || a."id"), 1, 24), a."clientAccountId", a."nodeId", a."containerId", a."allowedActions", a."isActive", jsonb_build_object('migratedFromAssignmentId', a."id"), a."createdAt", a."updatedAt"
FROM "ContainerAssignment" a
WHERE a."containerId" IS NOT NULL
ON CONFLICT ("clientAccountId", "containerId") DO NOTHING;

-- Prevent concurrent conflicting operations on the same container:
-- at most one REQUESTED/QUEUED/RUNNING operation per docker container.
CREATE UNIQUE INDEX "Operation_one_active_per_container" ON "Operation"("dockerContainerId") WHERE state IN ('REQUESTED', 'QUEUED', 'RUNNING');
