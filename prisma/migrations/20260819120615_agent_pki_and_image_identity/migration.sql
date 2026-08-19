/*
  Warnings:

  - You are about to drop the column `imageDigest` on the `DeploymentReleaseImage` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "NodeCertificateStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'REVOKED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "NodeTransportMode" ADD VALUE 'TLS_ERROR';

-- AlterTable
ALTER TABLE "DeploymentReleaseImage" DROP COLUMN "imageDigest",
ADD COLUMN     "imageId" TEXT,
ADD COLUMN     "repoDigest" TEXT;

-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "lastTlsError" TEXT,
ADD COLUMN     "lastTlsVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "tlsApiBaseUrl" TEXT;

-- CreateTable
CREATE TABLE "NodeAgentCertificate" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "fingerprintSha256" TEXT NOT NULL,
    "subjectIdentity" TEXT NOT NULL,
    "status" "NodeCertificateStatus" NOT NULL DEFAULT 'ACTIVE',
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeAgentCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NodeAgentCertificate_nodeId_status_idx" ON "NodeAgentCertificate"("nodeId", "status");

-- CreateIndex
CREATE INDEX "NodeAgentCertificate_notAfter_idx" ON "NodeAgentCertificate"("notAfter");

-- CreateIndex
CREATE UNIQUE INDEX "NodeAgentCertificate_fingerprintSha256_key" ON "NodeAgentCertificate"("fingerprintSha256");

-- AddForeignKey
ALTER TABLE "NodeAgentCertificate" ADD CONSTRAINT "NodeAgentCertificate_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
