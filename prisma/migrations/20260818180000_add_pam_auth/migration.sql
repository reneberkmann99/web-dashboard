-- Add PAM authentication support
CREATE TYPE "AuthSource" AS ENUM ('LOCAL', 'PAM');

ALTER TABLE "User" ADD COLUMN "authSource" "AuthSource" NOT NULL DEFAULT 'LOCAL';
ALTER TABLE "User" ADD COLUMN "pamUsername" TEXT;

CREATE UNIQUE INDEX "User_pamUsername_key" ON "User"("pamUsername");
CREATE INDEX "User_pamUsername_idx" ON "User"("pamUsername");
