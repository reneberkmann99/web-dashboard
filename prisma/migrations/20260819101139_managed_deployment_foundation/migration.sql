-- CreateEnum
CREATE TYPE "DeploymentSource" AS ENUM ('HOSTPANEL', 'GIT');

-- CreateEnum
CREATE TYPE "DeploymentOperationType" AS ENUM ('DEPLOY', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "DeploymentOperationPhase" AS ENUM ('VALIDATING', 'PLANNING', 'WAITING_FOR_CONFIRMATION', 'PULLING', 'APPLYING', 'VERIFYING', 'RECONCILING');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('INFO', 'WARNING', 'HIGH_RISK', 'BLOCKED');

-- CreateEnum
CREATE TYPE "FindingCategory" AS ENUM ('SECURITY', 'UNSUPPORTED', 'INVALID');

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" "DeploymentSource" NOT NULL DEFAULT 'HOSTPANEL',
    "composeProjectName" TEXT NOT NULL,
    "currentRevisionId" TEXT,
    "lastSuccessfulRevisionId" TEXT,
    "verifyGraceMs" INTEGER NOT NULL DEFAULT 30000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentRevision" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "source" "DeploymentSource" NOT NULL DEFAULT 'HOSTPANEL',
    "sourceRef" TEXT,
    "composeSource" TEXT NOT NULL,
    "composeCanonical" TEXT NOT NULL,
    "environmentSnapshot" JSONB NOT NULL,
    "secretReferences" TEXT[],
    "contentSha256" TEXT NOT NULL,
    "deployNote" TEXT,
    "analyzerVersion" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Secret" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Secret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretVersion" (
    "id" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecretVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentRevisionSecurityFinding" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "category" "FindingCategory" NOT NULL,
    "service" TEXT,
    "resourcePath" TEXT,
    "settingValue" TEXT,
    "message" TEXT NOT NULL,
    "analyzerVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentRevisionSecurityFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentSecurityAcknowledgement" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "findingFingerprint" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentSecurityAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentOperation" (
    "id" TEXT NOT NULL,
    "type" "DeploymentOperationType" NOT NULL,
    "state" "OperationState" NOT NULL DEFAULT 'REQUESTED',
    "phase" "DeploymentOperationPhase",
    "requestId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "revisionId" TEXT,
    "fromRevisionId" TEXT,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "actorRole" "Role",
    "error" TEXT,
    "result" JSONB,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_projectId_key" ON "Deployment"("projectId");

-- CreateIndex
CREATE INDEX "Deployment_projectId_idx" ON "Deployment"("projectId");

-- CreateIndex
CREATE INDEX "DeploymentRevision_deploymentId_idx" ON "DeploymentRevision"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentRevision_deploymentId_revisionNumber_key" ON "DeploymentRevision"("deploymentId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentRevision_deploymentId_contentSha256_key" ON "DeploymentRevision"("deploymentId", "contentSha256");

-- CreateIndex
CREATE INDEX "Secret_deploymentId_idx" ON "Secret"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Secret_deploymentId_key_key" ON "Secret"("deploymentId", "key");

-- CreateIndex
CREATE INDEX "SecretVersion_secretId_idx" ON "SecretVersion"("secretId");

-- CreateIndex
CREATE UNIQUE INDEX "SecretVersion_secretId_versionNumber_key" ON "SecretVersion"("secretId", "versionNumber");

-- CreateIndex
CREATE INDEX "DeploymentRevisionSecurityFinding_revisionId_idx" ON "DeploymentRevisionSecurityFinding"("revisionId");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentRevisionSecurityFinding_revisionId_fingerprint_key" ON "DeploymentRevisionSecurityFinding"("revisionId", "fingerprint");

-- CreateIndex
CREATE INDEX "DeploymentSecurityAcknowledgement_revisionId_idx" ON "DeploymentSecurityAcknowledgement"("revisionId");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentSecurityAcknowledgement_revisionId_findingFingerp_key" ON "DeploymentSecurityAcknowledgement"("revisionId", "findingFingerprint");

-- CreateIndex
CREATE INDEX "DeploymentOperation_deploymentId_state_idx" ON "DeploymentOperation"("deploymentId", "state");

-- CreateIndex
CREATE INDEX "DeploymentOperation_requestId_idx" ON "DeploymentOperation"("requestId");

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentRevision" ADD CONSTRAINT "DeploymentRevision_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentRevision" ADD CONSTRAINT "DeploymentRevision_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretVersion" ADD CONSTRAINT "SecretVersion_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "Secret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretVersion" ADD CONSTRAINT "SecretVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentRevisionSecurityFinding" ADD CONSTRAINT "DeploymentRevisionSecurityFinding_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "DeploymentRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentSecurityAcknowledgement" ADD CONSTRAINT "DeploymentSecurityAcknowledgement_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "DeploymentRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentSecurityAcknowledgement" ADD CONSTRAINT "DeploymentSecurityAcknowledgement_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentOperation" ADD CONSTRAINT "DeploymentOperation_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentOperation" ADD CONSTRAINT "DeploymentOperation_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Deployment-level operation lock: at most one active (non-terminal) operation
-- per deployment. Mirrors Operation_one_active_per_container. Not expressible
-- in the Prisma schema (no partial index support), added manually here.
CREATE UNIQUE INDEX "DeploymentOperation_one_active_per_deployment" ON "DeploymentOperation"("deploymentId") WHERE state IN ('REQUESTED', 'QUEUED', 'RUNNING');
