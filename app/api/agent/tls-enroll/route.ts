import { NextRequest } from "next/server";
import { z } from "zod";
import { enrollNodeCertificate } from "@/server/services/node-tls";
import { fail, ok, fromError } from "@/server/http";

/**
 * Agent TLS enrollment. Called BY THE AGENT (no browser session), authenticated
 * by a short-lived one-time enrollment token. The agent sends only a CSR — its
 * private key never leaves the node. HostPanel ignores CSR-requested subject/
 * SANs and assigns its own logical node identity.
 */
const tlsEnrollSchema = z.object({
  token: z.string().min(16).max(512),
  // Bounded to keep certificate parsing from becoming an unbounded input surface.
  csrPem: z.string().min(64).max(16384),
  tlsPort: z.number().int().min(1).max(65535).optional()
});

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = tlsEnrollSchema.parse(await request.json());
    const sourceIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    const result = await enrollNodeCertificate({
      token: body.token,
      csrPem: body.csrPem,
      tlsPort: body.tlsPort,
      sourceIp
    });

    switch (result.status) {
      case "invalid_token":
        return fail("INVALID_TOKEN", "Enrollment token is invalid, already used, or expired", 401);
      case "ca_not_configured":
        return fail("AGENT_CA_NOT_CONFIGURED", "HostPanel Agent CA is not configured", 503);
      case "invalid_csr":
        return fail("INVALID_CSR", "Certificate signing request could not be processed", 400);
      case "issued":
        return ok(
          {
            certPem: result.certPem,
            caPem: result.caPem,
            identity: result.identity,
            notAfter: result.notAfter.toISOString(),
            certificateId: result.certificateId
          },
          201
        );
    }
  } catch (error) {
    return fromError(error);
  }
}
