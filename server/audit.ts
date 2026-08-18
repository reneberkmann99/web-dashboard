import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/server/db";

/**
 * Audit logging for all privileged mutations.
 * Every state-changing admin/client action MUST produce an audit event.
 * Events are immutable once written.
 */

type AuditInput = {
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorRole?: Role | null;
  clientAccountId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  result: "SUCCESS" | "FAILURE";
  sourceIp?: string | null;
};

export async function logAuditEvent(input: AuditInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId ?? null,
      actorEmail: input.actorEmail ?? null,
      actorRole: input.actorRole ?? null,
      clientAccountId: input.clientAccountId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      metadata: (input.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      result: input.result,
      sourceIp: input.sourceIp ?? null
    }
  });
}
