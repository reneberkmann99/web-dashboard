-- CreateEnum
CREATE TYPE "SmtpEncryption" AS ENUM ('STARTTLS', 'TLS', 'NONE');

-- CreateEnum
CREATE TYPE "SmtpTestStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "PlatformEmailSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT,
    "port" INTEGER,
    "encryption" "SmtpEncryption" NOT NULL DEFAULT 'STARTTLS',
    "username" TEXT,
    "passwordEncrypted" TEXT,
    "fromName" TEXT,
    "fromEmail" TEXT,
    "replyTo" TEXT,
    "lastTestStatus" "SmtpTestStatus",
    "lastTestAt" TIMESTAMP(3),
    "lastTestSummary" TEXT,
    "lastTestDetail" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformEmailSettings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "PlatformEmailSettings" ADD CONSTRAINT "PlatformEmailSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
