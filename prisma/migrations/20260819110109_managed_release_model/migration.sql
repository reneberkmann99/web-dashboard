/*
  Warnings:

  - You are about to drop the column `currentRevisionId` on the `Deployment` table. All the data in the column will be lost.
  - You are about to drop the column `lastSuccessfulRevisionId` on the `Deployment` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "ReleaseHealth" AS ENUM ('HEALTHY', 'DEGRADED');

-- CreateEnum
CREATE TYPE "RuntimeState" AS ENUM ('UNKNOWN', 'CONVERGED', 'DEGRADED', 'DRIFTED');

-- CreateEnum
CREATE TYPE "NodeTransportMode" AS ENUM ('LEGACY_HTTP', 'TLS_VERIFIED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DeploymentOperationPhase" ADD VALUE 'PREPARING';
ALTER TYPE "DeploymentOperationPhase" ADD VALUE 'REVALIDATING';

-- AlterTable
ALTER TABLE "Deployment" DROP COLUMN "currentRevisionId",
DROP COLUMN "lastSuccessfulRevisionId",
ADD COLUMN     "currentReleaseId" TEXT,
ADD COLUMN     "lastHealthyReleaseId" TEXT,
ADD COLUMN     "runtimeState" "RuntimeState" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "transportMode" "NodeTransportMode" NOT NULL DEFAULT 'LEGACY_HTTP';

-- CreateTable
CREATE TABLE "DeploymentRelease" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "operationId" TEXT,
    "healthVerdict" "ReleaseHealth" NOT NULL,
    "composeVersion" TEXT,
    "appliedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentReleaseImage" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "imageRef" TEXT NOT NULL,
    "imageDigest" TEXT,

    CONSTRAINT "DeploymentReleaseImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentReleaseSecret" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "secretVersionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,

    CONSTRAINT "DeploymentReleaseSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeploymentRelease_deploymentId_createdAt_idx" ON "DeploymentRelease"("deploymentId", "createdAt");

-- CreateIndex
CREATE INDEX "DeploymentRelease_revisionId_idx" ON "DeploymentRelease"("revisionId");

-- CreateIndex
CREATE INDEX "DeploymentReleaseImage_releaseId_idx" ON "DeploymentReleaseImage"("releaseId");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentReleaseImage_releaseId_serviceName_key" ON "DeploymentReleaseImage"("releaseId", "serviceName");

-- CreateIndex
CREATE INDEX "DeploymentReleaseSecret_releaseId_idx" ON "DeploymentReleaseSecret"("releaseId");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentReleaseSecret_releaseId_key_key" ON "DeploymentReleaseSecret"("releaseId", "key");

-- AddForeignKey
ALTER TABLE "DeploymentRelease" ADD CONSTRAINT "DeploymentRelease_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentRelease" ADD CONSTRAINT "DeploymentRelease_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "DeploymentRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentReleaseImage" ADD CONSTRAINT "DeploymentReleaseImage_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "DeploymentRelease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentReleaseSecret" ADD CONSTRAINT "DeploymentReleaseSecret_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "DeploymentRelease"("id") ON DELETE CASCADE ON UPDATE CASCADE;
