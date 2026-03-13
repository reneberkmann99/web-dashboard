import { ensureRole, requireApiSession } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { createNodeSchema } from "@/server/validation/admin";
import { encryptSecret } from "@/server/security/crypto";
import { fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

export async function GET(): Promise<Response> {
  try {
    const session = await requireApiSession();
    ensureRole(session, ["ADMIN"]);

    const nodes = await prisma.node.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        hostname: true,
        apiBaseUrl: true,
        status: true,
        isActive: true,
        _count: {
          select: {
            assignments: true
          }
        }
      }
    });

    return ok({ nodes });
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiSession();
    ensureRole(session, ["ADMIN"]);
    const sourceIp = getSourceIpFromRequest(request);

    const body = createNodeSchema.parse(await request.json());

    const created = await prisma.node.create({
      data: {
        name: body.name,
        hostname: body.hostname,
        apiBaseUrl: body.apiBaseUrl,
        apiKeyEncrypted: encryptSecret(body.apiKey),
        dockerContext: body.dockerContext,
        isActive: body.isActive ?? true,
        status: "UNKNOWN"
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "NODE_CREATE",
      targetType: "NODE",
      targetId: created.id,
      metadata: {
        hostname: created.hostname,
        apiBaseUrl: created.apiBaseUrl
      },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ id: created.id }, 201);
  } catch (error) {
    return fromError(error);
  }
}
