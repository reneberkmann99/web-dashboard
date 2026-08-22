-- DropIndex
DROP INDEX "Domain_hostname_key";

-- CreateIndex
CREATE INDEX "Domain_hostname_idx" ON "Domain"("hostname");
