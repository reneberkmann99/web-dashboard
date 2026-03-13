import { ensureRole, requireApiSession } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { updateNodeSchema } from "@/server/validation/admin";
import { encryptSecret } from "@/server/security/crypto";
import { fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiSession();
    ensureRole(session, ["ADMIN"]);
    const sourceIp = getSourceIpFromRequest(request);
    const { id } = await params;
    const body = updateNodeSchema.parse(await request.json());

    await prisma.node.update({
      where: { id },
      data: {
        name: body.name,
        hostname: body.hostname,
        apiBaseUrl: body.apiBaseUrl,
        dockerContext: body.dockerContext,
        isActive: body.isActive,
        ...(body.apiKey ? { apiKeyEncrypted: encryptSecret(body.apiKey) } : {})
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "NODE_UPDATE",
      targetType: "NODE",
      targetId: id,
      metadata: {
        ...body,
        ...(body.apiKey ? { apiKey: "<redacted>" } : {})
      },
      result: "SUCCESS",
      sourceIp
    });

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiSession();
    ensureRole(session, ["ADMIN"]);
    const sourceIp = getSourceIpFromRequest(request);
    const { id } = await params;

    await prisma.node.update({
      where: { id },
      data: {
        isActive: false,
        status: "INACTIVE"
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "NODE_DEACTIVATE",
      targetType: "NODE",
      targetId: id,
      result: "SUCCESS",
      sourceIp
    });

    return ok({ success: true });
  } catch (error) {
    return fromError(error);
  }
}
