import crypto from "node:crypto";
import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { fromError, ok } from "@/server/http";
import { logAuditEvent } from "@/server/audit";
import { getSourceIpFromRequest } from "@/server/request";
import { z } from "zod";

const ENROLLMENT_TTL_MINUTES = 15;

const createEnrollmentSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  hostname: z.string().min(2).max(255).optional(),
  nodeId: z.string().cuid().nullable().optional()
});

/**
 * Issue a short-lived, single-use node enrollment token. The raw token is
 * returned exactly once — after this response it only exists as a SHA-256
 * hash in the database.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);

    const body = createEnrollmentSchema.parse(await request.json());

    const rawToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MINUTES * 60 * 1000);

    const created = await prisma.nodeEnrollmentToken.create({
      data: {
        tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
        nodeId: body.nodeId ?? null,
        createdById: session.userId,
        expiresAt
      }
    });

    await logAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "NODE_ENROLLMENT_TOKEN_CREATED",
      targetType: "NODE_ENROLLMENT_TOKEN",
      targetId: created.id,
      metadata: { expiresAt: expiresAt.toISOString(), ttlMinutes: ENROLLMENT_TTL_MINUTES },
      result: "SUCCESS",
      sourceIp
    });

    return ok(
      {
        token: rawToken,
        expiresAt: expiresAt.toISOString(),
        ttlMinutes: ENROLLMENT_TTL_MINUTES,
        nodeId: created.nodeId ?? null
      },
      201
    );
  } catch (error) {
    return fromError(error);
  }
}
