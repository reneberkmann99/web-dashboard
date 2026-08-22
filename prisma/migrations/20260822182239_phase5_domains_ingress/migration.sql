-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'INVALID', 'DISABLED');

-- CreateEnum
CREATE TYPE "IpVersion" AS ENUM ('V4', 'V6');

-- CreateEnum
CREATE TYPE "PublicAddressAllocation" AS ENUM ('SHARED', 'DEDICATED');

-- CreateEnum
CREATE TYPE "IngressProviderKind" AS ENUM ('MANUAL', 'NGINX_PROXY_MANAGER');

-- CreateEnum
CREATE TYPE "IngressExposureType" AS ENUM ('HTTPS', 'HTTP', 'TCP', 'UDP');

-- CreateEnum
CREATE TYPE "IngressEndpointStatus" AS ENUM ('PENDING', 'ACTIVE', 'ERROR', 'DISABLED');

-- AlterTable
ALTER TABLE "ClientAccount" ADD COLUMN     "maxDedicatedIps" INTEGER,
ADD COLUMN     "maxDomains" INTEGER,
ADD COLUMN     "maxIngressEndpoints" INTEGER,
ADD COLUMN     "maxTcpUdpEndpoints" INTEGER;

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "clientAccountId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "status" "DomainStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verificationToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicAddress" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "ipVersion" "IpVersion" NOT NULL,
    "allocation" "PublicAddressAllocation" NOT NULL DEFAULT 'SHARED',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "reservedForOrgId" TEXT,
    "providerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngressProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "IngressProviderKind" NOT NULL DEFAULT 'MANUAL',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "gatewayHostname" TEXT,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngressProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngressEndpoint" (
    "id" TEXT NOT NULL,
    "clientAccountId" TEXT NOT NULL,
    "workloadId" TEXT NOT NULL,
    "containerId" TEXT,
    "serviceName" TEXT,
    "targetPort" INTEGER NOT NULL,
    "exposureType" "IngressExposureType" NOT NULL,
    "domainId" TEXT,
    "publicAddressId" TEXT NOT NULL,
    "publicPort" INTEGER,
    "providerId" TEXT,
    "status" "IngressEndpointStatus" NOT NULL DEFAULT 'PENDING',
    "statusDetail" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngressEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Domain_hostname_key" ON "Domain"("hostname");

-- CreateIndex
CREATE INDEX "Domain_clientAccountId_idx" ON "Domain"("clientAccountId");

-- CreateIndex
CREATE INDEX "Domain_status_idx" ON "Domain"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PublicAddress_ipAddress_key" ON "PublicAddress"("ipAddress");

-- CreateIndex
CREATE INDEX "PublicAddress_enabled_idx" ON "PublicAddress"("enabled");

-- CreateIndex
CREATE INDEX "PublicAddress_reservedForOrgId_idx" ON "PublicAddress"("reservedForOrgId");

-- CreateIndex
CREATE INDEX "PublicAddress_providerId_idx" ON "PublicAddress"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "IngressEndpoint_domainId_key" ON "IngressEndpoint"("domainId");

-- CreateIndex
CREATE INDEX "IngressEndpoint_clientAccountId_idx" ON "IngressEndpoint"("clientAccountId");

-- CreateIndex
CREATE INDEX "IngressEndpoint_workloadId_idx" ON "IngressEndpoint"("workloadId");

-- CreateIndex
CREATE INDEX "IngressEndpoint_publicAddressId_idx" ON "IngressEndpoint"("publicAddressId");

-- CreateIndex
CREATE INDEX "IngressEndpoint_providerId_idx" ON "IngressEndpoint"("providerId");

-- CreateIndex
CREATE INDEX "IngressEndpoint_status_idx" ON "IngressEndpoint"("status");

-- CreateIndex
CREATE UNIQUE INDEX "IngressEndpoint_publicAddressId_publicPort_exposureType_key" ON "IngressEndpoint"("publicAddressId", "publicPort", "exposureType");

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_clientAccountId_fkey" FOREIGN KEY ("clientAccountId") REFERENCES "ClientAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicAddress" ADD CONSTRAINT "PublicAddress_reservedForOrgId_fkey" FOREIGN KEY ("reservedForOrgId") REFERENCES "ClientAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicAddress" ADD CONSTRAINT "PublicAddress_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "IngressProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngressEndpoint" ADD CONSTRAINT "IngressEndpoint_clientAccountId_fkey" FOREIGN KEY ("clientAccountId") REFERENCES "ClientAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngressEndpoint" ADD CONSTRAINT "IngressEndpoint_workloadId_fkey" FOREIGN KEY ("workloadId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngressEndpoint" ADD CONSTRAINT "IngressEndpoint_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "Container"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngressEndpoint" ADD CONSTRAINT "IngressEndpoint_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngressEndpoint" ADD CONSTRAINT "IngressEndpoint_publicAddressId_fkey" FOREIGN KEY ("publicAddressId") REFERENCES "PublicAddress"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngressEndpoint" ADD CONSTRAINT "IngressEndpoint_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "IngressProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngressEndpoint" ADD CONSTRAINT "IngressEndpoint_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
