import { Prisma, PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

export const prisma =
  global.prismaGlobal ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
  });

if (process.env.NODE_ENV !== "production") {
  global.prismaGlobal = prisma;
}

/**
 * Locks a ClientAccount row for the rest of the current transaction
 * (Postgres `SELECT ... FOR UPDATE`). Used to serialize a
 * count-existing-rows-then-insert quota check (domains, ingress endpoints,
 * dedicated IPs) so two concurrent requests against the same organization
 * can never both observe headroom under the limit and both succeed — see
 * server/services/domains.ts and server/services/ingress.ts.
 */
export async function lockClientAccountForQuota(tx: Prisma.TransactionClient, clientAccountId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "ClientAccount" WHERE id = ${clientAccountId} FOR UPDATE`;
}
