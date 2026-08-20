import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { fromError, ok } from "@/server/http";

/** Lightweight name/id references for filter dropdowns. */
export async function GET(): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const [nodes, clients, workloads] = await Promise.all([
      prisma.node.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      prisma.clientAccount.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      prisma.project.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    ]);
    return ok({ nodes, clients, workloads });
  } catch (error) {
    return fromError(error);
  }
}
