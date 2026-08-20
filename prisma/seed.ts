import { PrismaClient, Role } from "@prisma/client";
import { hashPassword } from "../server/auth/password";
import { encryptSecret } from "../server/security/crypto";

/**
 * Bootstrap seed — run ONCE on a fresh database (or via `npm run db:seed`).
 *
 * Security notes:
 *  - No default or example passwords. The admin account is created with a
 *    password supplied via SEED_ADMIN_PASSWORD (required); all other users
 *    must go through the invite/activation flow (admin UI).
 *  - Demo client accounts are intentionally NOT created anymore.
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@noderaft.local";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!adminPassword || adminPassword.length < 12) {
    // eslint-disable-next-line no-console
    console.error(
      "SEED_ADMIN_PASSWORD is required (>= 12 chars). Refusing to create an admin with a weak/absent password."
    );
    process.exit(1);
  }

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      displayName: "Noderaft Admin",
      role: Role.ADMIN,
      isActive: true,
      passwordHash: await hashPassword(adminPassword)
    },
    create: {
      email: adminEmail,
      displayName: "Noderaft Admin",
      role: Role.ADMIN,
      isActive: true,
      passwordHash: await hashPassword(adminPassword)
    }
  });

  // Node bootstrap (optional): a seed can pre-register an agent if the
  // environment provides the agent key. The key is encrypted at rest using
  // the same facility as the API path. Enrollment tokens are preferred over
  // this path for production.
  if (process.env.SEED_AGENT_NAME && process.env.SEED_AGENT_URL && process.env.AGENT_API_KEY) {
    const nodeHostname = process.env.SEED_AGENT_HOSTNAME ?? process.env.SEED_AGENT_NAME.toLowerCase();
    await prisma.node.upsert({
      where: { hostname: nodeHostname },
      update: {
        name: process.env.SEED_AGENT_NAME,
        apiBaseUrl: process.env.SEED_AGENT_URL,
        apiKeyEncrypted: encryptSecret(process.env.AGENT_API_KEY)
      },
      create: {
        name: process.env.SEED_AGENT_NAME,
        hostname: nodeHostname,
        apiBaseUrl: process.env.SEED_AGENT_URL,
        apiKeyEncrypted: encryptSecret(process.env.AGENT_API_KEY),
        status: "UNKNOWN",
        isActive: true
      }
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
