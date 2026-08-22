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

/**
 * Locks a PublicAddress row for the rest of the current transaction. Both
 * updatePublicAddress (changing allocation/reservation) and
 * createIngressEndpoint (reading allocation/reservation before binding to
 * it) must take this lock — and re-read the row under it, never reuse a
 * pre-lock snapshot — or a reservation change and a concurrent endpoint
 * creation on the same address can interleave past each other's own check.
 * Both call sites lock the address FIRST, before any
 * lockClientAccountForQuota call: a consistent order across both functions
 * avoids a deadlock between them (updatePublicAddress only knows which
 * ClientAccount needs the quota lock after re-reading the address anyway) —
 * see server/services/ingress.ts.
 */
export async function lockPublicAddressForUpdate(tx: Prisma.TransactionClient, publicAddressId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "PublicAddress" WHERE id = ${publicAddressId} FOR UPDATE`;
}

/**
 * Locks a Container row for the rest of the current transaction. Container
 * deletion (server/services/container-lifecycle.ts) is a soft delete
 * (isActive: false, row survives) with no DB constraint reconciling
 * IngressEndpoint.containerId automatically — this lock is what serializes
 * that deletion against a concurrent createIngressEndpoint/
 * updateIngressEndpoint attaching the SAME container, so one always sees the
 * other's committed result (a freshly-inactive container is rejected as a
 * backend; a freshly-attached endpoint blocks the deletion) instead of both
 * racing past a stale isActive read.
 */
export async function lockContainerForUpdate(tx: Prisma.TransactionClient, containerId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Container" WHERE id = ${containerId} FOR UPDATE`;
}
