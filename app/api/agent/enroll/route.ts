import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { encryptSecret } from "@/server/security/crypto";
import { logAuditEvent } from "@/server/audit";
import { fail, ok } from "@/server/http";
import { z } from "zod";

/**
 * Node self-enrollment endpoint. Called BY THE AGENT (no browser session).
 * Authenticated by a one-time enrollment token. Issues a fresh per-node API
 * key exactly once; the raw key is returned in this response only — it is
 * never shown again (stored encrypted at rest via NODE_CREDENTIALS_KEY).
 */
const enrollSchema = z.object({
  token: z.string().min(16).max(512),
  agentVersion: z.string().max(64).optional(),
  dockerVersion: z.string().max(64).optional(),
  osInfo: z.record(z.unknown()).optional(),
  systemInfo: z.record(z.unknown()).optional(),
  apiBaseUrl: z.string().url().max(512).optional(),
  hostname: z.string().min(1).max(255).optional(),
  name: z.string().min(1).max(120).optional()
});

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = enrollSchema.parse(await request.json());
    const sourceIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    const tokenHash = crypto.createHash("sha256").update(body.token).digest("hex");
    const token = await prisma.nodeEnrollmentToken.findUnique({ where: { tokenHash } });

    if (!token || token.usedAt || token.expiresAt.getTime() < Date.now()) {
      await logAuditEvent({
        action: "NODE_ENROLL_FAILED",
        targetType: "NODE_ENROLLMENT_TOKEN",
        targetId: token?.id ?? null,
        metadata: { reason: token ? (token.usedAt ? "already_used" : "expired") : "not_found" },
        result: "FAILURE",
        sourceIp
      });
      return fail("INVALID_TOKEN", "Enrollment token is invalid, already used, or expired", 401);
    }

    // Pre-created node (admin generated token for a node row) or create on the fly.
    let node = token.nodeId ? await prisma.node.findUnique({ where: { id: token.nodeId } }) : null;
    if (!node) {
      const hostname = body.hostname ?? body.apiBaseUrl ?? `node-${Date.now()}`;
      const existing = await prisma.node.findUnique({ where: { hostname } });
      if (existing) {
        node = existing;
      } else {
        node = await prisma.node.create({
          data: {
            name: body.name ?? hostname,
            hostname,
            apiBaseUrl: body.apiBaseUrl ?? `http://${hostname}:8081`,
            apiKeyEncrypted: encryptSecret("placeholder-rotated-on-enroll"),
            status: "UNKNOWN",
            isActive: true
          }
        });
      }
    }

    // Fresh per-node key — generated here, never by the administrator.
    const apiKey = crypto.randomBytes(32).toString("hex");

    await prisma.$transaction([
      prisma.node.update({
        where: { id: node.id },
        data: {
          apiKeyEncrypted: encryptSecret(apiKey),
          agentVersion: body.agentVersion ?? null,
          dockerVersion: body.dockerVersion ?? null,
          osInfo: (body.osInfo as object) ?? undefined,
          systemInfo: (body.systemInfo as object) ?? undefined,
          status: "ONLINE",
          lastHeartbeatAt: new Date()
        }
      }),
      prisma.nodeEnrollmentToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() }
      })
    ]);

    await logAuditEvent({
      action: "NODE_ENROLLED",
      targetType: "NODE",
      targetId: node.id,
      metadata: {
        hostname: node.hostname,
        agentVersion: body.agentVersion ?? null,
        dockerVersion: body.dockerVersion ?? null
      },
      result: "SUCCESS",
      sourceIp
    });

    // The key is returned exactly once here.
    return ok({ nodeId: node.id, apiKey }, 201);
  } catch (error) {
    const { fromError } = await import("@/server/http");
    return fromError(error);
  }
}
