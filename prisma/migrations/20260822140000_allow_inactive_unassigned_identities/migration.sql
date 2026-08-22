-- A removed organization membership retains the platform identity and its
-- audit actor snapshots. Such identities must be inactive until a platform
-- admin assigns an organization again; active organization users still
-- require an organization at the database level.
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_client_role_requires_client";

ALTER TABLE "User" ADD CONSTRAINT "User_client_role_requires_client"
CHECK (
  "role" = 'ADMIN'
  OR "clientAccountId" IS NOT NULL
  OR "isActive" = false
);
