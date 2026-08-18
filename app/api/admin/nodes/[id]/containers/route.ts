import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";
import { listContainersForNode } from "@/server/services/workloads";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const id = cuidParamSchema.parse((await params).id);
    await requireApiRole("ADMIN");
    const node = await prisma.node.findUnique({ where: { id } });
    if (!node) return fail("NOT_FOUND", "Node not found", 404);
    const containers = await listContainersForNode(id);
    return ok({ containers });
  } catch (error) {
    return fromError(error);
  }
}
