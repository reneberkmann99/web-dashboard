-- Safety repair: attach any client-role user missing a client account to the
-- "Linux Users" account (auto-created by the PAM provisioning path). This
-- mirrors what the PAM flow does and guarantees the CHECK below cannot fail
-- on legacy data. No rows are deleted.
INSERT INTO "ClientAccount" ("id", "name", "slug", "isActive", "createdAt", "updatedAt")
SELECT 'c' || substr(md5('linux-users' || now()::text), 1, 24), 'Linux Users', 'linux-users', true, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "ClientAccount" WHERE slug = 'linux-users');

UPDATE "User" u SET "clientAccountId" = lu.id
FROM "ClientAccount" lu
WHERE lu.slug = 'linux-users'
  AND u.role IN ('CLIENT', 'CLIENT_ADMIN', 'CLIENT_OPERATOR', 'CLIENT_VIEWER')
  AND u."clientAccountId" IS NULL;

-- Convert legacy CLIENT role rows to the new explicit client roles.
-- CLIENT_OPERATOR preserves the previous capability (view + operate).
UPDATE "User" SET role = 'CLIENT_OPERATOR' WHERE role = 'CLIENT';

-- Client roles must belong to a client account; ADMIN may stand alone.
ALTER TABLE "User" ADD CONSTRAINT "User_client_role_requires_client"
  CHECK (role = 'ADMIN' OR "clientAccountId" IS NOT NULL);

-- New inserts default to the operator role (enum value now committed).
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'CLIENT_OPERATOR';
