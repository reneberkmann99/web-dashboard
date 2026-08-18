import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { cuidParamSchema } from "@/server/validation/admin";
import { fail, fromError, ok } from "@/server/http";
import { listContainersForNode, toWorkloadDetail } from "@/server/services/workloads";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const id = cuidParamSchema.parse((await params).id);
    await requireApiRole("ADMIN");

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        node: { select: { id: true, name: true, hostname: true, status: true } },
        clientAccount: { select: { id: true, name: true, slug: true } },
        grants: { where: { isActive: true }, select: { id: true, allowedActions: true, clientAccount: { select: { name: true } } } },
        containers: { where: { isActive: true }, select: { dockerContainerId: true, dockerName: true } }
      }
    });
    if (!project) {
      return fail("NOT_FOUND", "Workload not found", 404);
    }

    const containers = await listContainersForNode(project.node.id);
    const detail = toWorkloadDetail(project, containers);

    const activity = await prisma.auditLog.findMany({
      where: {
        OR: [
          { targetType: "PROJECT", targetId: project.id },
          { action: { in: ["ASSIGNMENT_CREATE", "ASSIGNMENT_DELETE", "GRANT_CREATE", "GRANT_DEACTIVATE"] } }
        ]
      },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, action: true, actorEmail: true, result: true, createdAt: true, metadata: true }
    });

    return ok({ workload: detail, activity });
  } catch (error) {
    return fromError(error);
  }
}
