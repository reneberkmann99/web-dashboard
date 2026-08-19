import { z } from "zod";
import { requireApiRole } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import {
  createTlsEnrollmentToken,
  triggerAgentTlsEnrollment,
  verifyAndActivateCertificate,
  revokeNodeCertificate,
  getNodeTlsStatus
} from "@/server/services/node-tls";
import { cuidParamSchema } from "@/server/validation/admin";
import { fromError, fail, ok } from "@/server/http";
import { getSourceIpFromRequest } from "@/server/request";

/** Node secure-transport (TLS) status. ADMIN only. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const id = cuidParamSchema.parse((await params).id);
    const status = await getNodeTlsStatus(id);
    if (!status) return fail("NOT_FOUND", "Node not found", 404);
    return ok(status);
  } catch (error) {
    return fromError(error);
  }
}

const actionSchema = z.object({
  action: z.enum(["enroll", "rotate", "revoke"]),
  /** HTTPS base URL to verify, e.g. https://agent:9081. */
  tlsApiBaseUrl: z.string().url().max(512).optional()
});

/**
 * Enroll / rotate / revoke secure agent transport.
 *
 * enroll+rotate are identical mechanically (issue candidate → agent installs →
 * live verify → promote). A failed verification leaves the previously working
 * certificate ACTIVE, so rotation can never strand a node.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const session = await requireApiRole("ADMIN");
    const sourceIp = getSourceIpFromRequest(request);
    const nodeId = cuidParamSchema.parse((await params).id);
    const body = actionSchema.parse(await request.json());

    const node = await prisma.node.findUnique({ where: { id: nodeId } });
    if (!node) return fail("NOT_FOUND", "Node not found", 404);

    if (body.action === "revoke") {
      const result = await revokeNodeCertificate({ nodeId, actor: session, sourceIp });
      return ok({ revoked: result.revoked });
    }

    // 1. one-time short-lived token
    const { token, expiresAt } = await createTlsEnrollmentToken({ nodeId, actor: session, sourceIp });

    // 2. agent generates key + CSR locally and installs the signed certificate
    const triggered = await triggerAgentTlsEnrollment(node, token);
    if (!triggered.ok) {
      return fail("AGENT_ENROLLMENT_FAILED", "The agent could not complete TLS enrollment", 502, {
        tokenExpiresAt: expiresAt.toISOString()
      });
    }

    // 3. locate the certificate just issued for this node
    const candidate = await prisma.nodeAgentCertificate.findFirst({
      where: { nodeId },
      orderBy: { issuedAt: "desc" }
    });
    if (!candidate) return fail("CERTIFICATE_NOT_FOUND", "No certificate was issued", 500);

    // 4. LIVE verified-HTTPS check; only this promotes the node to TLS_VERIFIED
    const tlsBase =
      body.tlsApiBaseUrl ??
      (() => {
        const u = new URL(node.apiBaseUrl);
        u.protocol = "https:";
        u.port = String(triggered.tlsPort ?? Number(u.port || 8081) + 1000);
        return u.toString();
      })();

    const verified = await verifyAndActivateCertificate({
      nodeId,
      certificateId: candidate.id,
      tlsApiBaseUrl: tlsBase,
      actor: session,
      sourceIp
    });

    if (!verified.ok) {
      return fail("TLS_VERIFICATION_FAILED", verified.message, 502, { code: verified.code });
    }

    return ok({
      verified: true,
      tlsApiBaseUrl: tlsBase,
      identity: verified.tls.identity,
      peerFingerprintSha256: verified.tls.peerFingerprintSha256,
      certificateId: candidate.id
    });
  } catch (error) {
    return fromError(error);
  }
}
