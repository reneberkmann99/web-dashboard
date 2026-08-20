-- CreateEnum
CREATE TYPE "AttentionSeverity" AS ENUM ('CRITICAL', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "AttentionResourceType" AS ENUM ('NODE', 'CONTAINER', 'WORKLOAD', 'OPERATION', 'DEPLOYMENT');

-- CreateTable
CREATE TABLE "ContainerRestartSample" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "dockerContainerId" TEXT NOT NULL,
    "restartCount" INTEGER NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContainerRestartSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeResourceSample" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "cpuPercent" DOUBLE PRECISION,
    "memPercent" DOUBLE PRECISION,
    "diskPercent" DOUBLE PRECISION,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeResourceSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttentionState" (
    "id" TEXT NOT NULL,
    "resourceType" "AttentionResourceType" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "conditionType" TEXT NOT NULL,
    "severity" "AttentionSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "href" TEXT,
    "metadata" JSONB,
    "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttentionState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContainerRestartSample_nodeId_dockerContainerId_observedAt_idx" ON "ContainerRestartSample"("nodeId", "dockerContainerId", "observedAt");

-- CreateIndex
CREATE INDEX "NodeResourceSample_nodeId_observedAt_idx" ON "NodeResourceSample"("nodeId", "observedAt");

-- CreateIndex
CREATE INDEX "AttentionState_resolvedAt_idx" ON "AttentionState"("resolvedAt");

-- CreateIndex
CREATE INDEX "AttentionState_severity_resolvedAt_idx" ON "AttentionState"("severity", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttentionState_resourceType_resourceId_conditionType_key" ON "AttentionState"("resourceType", "resourceId", "conditionType");

