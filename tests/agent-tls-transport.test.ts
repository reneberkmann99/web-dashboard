import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import forge from "node-forge";
import crypto from "node:crypto";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hostpanel-tls-test-"));
process.env.HOSTPANEL_AGENT_CA_CERT_PATH = path.join(tmpDir, "ca.pem");
process.env.HOSTPANEL_AGENT_CA_KEY_PATH = path.join(tmpDir, "ca-key.pem");

const { bootstrapCa, caExists, signNodeCsr, nodeIdentity } = await import("@/server/security/agent-pki");
const { secureFetch, SecureTransportError, verifyNodeTlsEndpoint, invalidateSecureAgent } = await import(
  "@/server/services/node-agent/secure-transport"
);
const { getManagedExecutionEligibility } = await import("@/server/services/node-agent/execution-eligibility");

/** Generate a key + CSR the way the agent does, and sign it. */
function issueFor(nodeId: string, lifetimeDays = 90) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: "commonName", value: "hostpanel-agent" }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  const issued = signNodeCsr({ nodeId, csrPem: forge.pki.certificationRequestToPem(csr), lifetimeDays });
  return { issued, keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

/** Start a throwaway HTTPS server presenting the given cert/key. */
async function startTlsServer(certPem: string, keyPem: string): Promise<{ port: number; close: () => void }> {
  const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ nodeOnline: true, path: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => server.close() };
}

beforeAll(async () => {
  resetDatabase();
  if (!caExists()) bootstrapCa({ years: 1 });
});

describe("verified HTTPS agent transport", () => {
  it("REFUSES a non-HTTPS destination before any network I/O", async () => {
    const world = await seedWorld();
    const node = await prisma.node.update({
      where: { id: world.node1.id },
      data: { transportMode: "TLS_VERIFIED", tlsApiBaseUrl: "http://127.0.0.1:1/" }
    });

    await expect(
      secureFetch(node, { method: "POST", path: "/deployments/x/apply", body: JSON.stringify({ secrets: { A: "s" } }) })
    ).rejects.toMatchObject({ code: "INSECURE_DESTINATION" });
  });

  it("succeeds against a correctly-issued, pinned certificate", async () => {
    const world = await seedWorld();
    const { issued, keyPem } = issueFor(world.node1.id);
    const server = await startTlsServer(issued.certPem, keyPem);
    try {
      await prisma.nodeAgentCertificate.create({
        data: {
          nodeId: world.node1.id, serialNumber: issued.serialNumber, fingerprintSha256: issued.fingerprintSha256,
          subjectIdentity: issued.identity, status: "ACTIVE", notBefore: issued.notBefore, notAfter: issued.notAfter
        }
      });
      const node = await prisma.node.update({
        where: { id: world.node1.id },
        data: { tlsApiBaseUrl: `https://127.0.0.1:${server.port}` }
      });
      const result = await secureFetch(node, { method: "GET", path: "/health" });
      expect(result.status).toBe(200);
      expect(result.tls.identity).toBe(nodeIdentity(world.node1.id));
      expect(result.tls.peerFingerprintSha256).toBe(issued.fingerprintSha256);
      expect(result.tls.url.startsWith("https://")).toBe(true);
    } finally {
      server.close();
      invalidateSecureAgent(world.node1.id);
    }
  });

  it("rejects a certificate issued for a DIFFERENT node (no impersonation)", async () => {
    const world = await seedWorld();
    // Certificate legitimately issued by our CA, but for node2.
    const { issued, keyPem } = issueFor(world.node2.id);
    const server = await startTlsServer(issued.certPem, keyPem);
    try {
      // Registered as node1's active certificate metadata (fingerprint matches),
      // but the SAN identity belongs to node2 → identity check must fail.
      await prisma.nodeAgentCertificate.create({
        data: {
          nodeId: world.node1.id, serialNumber: issued.serialNumber, fingerprintSha256: issued.fingerprintSha256,
          subjectIdentity: issued.identity, status: "ACTIVE", notBefore: issued.notBefore, notAfter: issued.notAfter
        }
      });
      const node = await prisma.node.update({
        where: { id: world.node1.id },
        data: { tlsApiBaseUrl: `https://127.0.0.1:${server.port}` }
      });
      await expect(secureFetch(node, { method: "GET", path: "/health" })).rejects.toBeInstanceOf(SecureTransportError);
    } finally {
      server.close();
      invalidateSecureAgent(world.node1.id);
    }
  });

  it("rejects an unknown-CA (self-signed) certificate", async () => {
    const world = await seedWorld();
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date(Date.now() - 60000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    const attrs = [{ name: "commonName", value: nodeIdentity(world.node1.id) }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: "subjectAltName", altNames: [{ type: 2, value: nodeIdentity(world.node1.id) }] }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);

    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const fingerprint = crypto.createHash("sha256").update(Buffer.from(der, "binary")).digest("hex");

    const server = await startTlsServer(certPem, forge.pki.privateKeyToPem(keys.privateKey));
    try {
      await prisma.nodeAgentCertificate.create({
        data: {
          nodeId: world.node1.id, serialNumber: "01", fingerprintSha256: fingerprint,
          subjectIdentity: nodeIdentity(world.node1.id), status: "ACTIVE",
          notBefore: cert.validity.notBefore, notAfter: cert.validity.notAfter
        }
      });
      const node = await prisma.node.update({
        where: { id: world.node1.id },
        data: { tlsApiBaseUrl: `https://127.0.0.1:${server.port}` }
      });
      // Self-signed: not issued by the HostPanel CA → chain validation fails.
      await expect(secureFetch(node, { method: "GET", path: "/health" })).rejects.toBeInstanceOf(SecureTransportError);
    } finally {
      server.close();
      invalidateSecureAgent(world.node1.id);
    }
  });

  it("rejects a superseded/revoked certificate even though it still chains to the CA", async () => {
    const world = await seedWorld();
    const { issued, keyPem } = issueFor(world.node1.id);
    const server = await startTlsServer(issued.certPem, keyPem);
    try {
      await prisma.nodeAgentCertificate.create({
        data: {
          nodeId: world.node1.id, serialNumber: issued.serialNumber, fingerprintSha256: issued.fingerprintSha256,
          subjectIdentity: issued.identity, status: "REVOKED", revokedAt: new Date(),
          notBefore: issued.notBefore, notAfter: issued.notAfter
        }
      });
      const node = await prisma.node.update({
        where: { id: world.node1.id },
        data: { tlsApiBaseUrl: `https://127.0.0.1:${server.port}` }
      });
      await expect(secureFetch(node, { method: "GET", path: "/health" })).rejects.toMatchObject({
        code: "NO_ACTIVE_CERTIFICATE"
      });
    } finally {
      server.close();
      invalidateSecureAgent(world.node1.id);
    }
  });

  it("rejects an expired certificate", async () => {
    const world = await seedWorld();
    const { issued, keyPem } = issueFor(world.node1.id);
    const server = await startTlsServer(issued.certPem, keyPem);
    try {
      await prisma.nodeAgentCertificate.create({
        data: {
          nodeId: world.node1.id, serialNumber: issued.serialNumber, fingerprintSha256: issued.fingerprintSha256,
          subjectIdentity: issued.identity, status: "ACTIVE",
          notBefore: new Date(Date.now() - 10 * 86400000), notAfter: new Date(Date.now() - 86400000)
        }
      });
      const node = await prisma.node.update({
        where: { id: world.node1.id },
        data: { tlsApiBaseUrl: `https://127.0.0.1:${server.port}` }
      });
      await expect(secureFetch(node, { method: "GET", path: "/health" })).rejects.toMatchObject({
        code: "CERTIFICATE_EXPIRED"
      });
    } finally {
      server.close();
      invalidateSecureAgent(world.node1.id);
    }
  });

  it("rejects a not-yet-valid certificate", async () => {
    const world = await seedWorld();
    const { issued, keyPem } = issueFor(world.node1.id);
    const server = await startTlsServer(issued.certPem, keyPem);
    try {
      await prisma.nodeAgentCertificate.create({
        data: {
          nodeId: world.node1.id, serialNumber: issued.serialNumber, fingerprintSha256: issued.fingerprintSha256,
          subjectIdentity: issued.identity, status: "ACTIVE",
          notBefore: new Date(Date.now() + 86400000), notAfter: new Date(Date.now() + 10 * 86400000)
        }
      });
      const node = await prisma.node.update({
        where: { id: world.node1.id },
        data: { tlsApiBaseUrl: `https://127.0.0.1:${server.port}` }
      });
      await expect(secureFetch(node, { method: "GET", path: "/health" })).rejects.toMatchObject({
        code: "CERTIFICATE_NOT_YET_VALID"
      });
    } finally {
      server.close();
      invalidateSecureAgent(world.node1.id);
    }
  });

  it("certificate identity survives an endpoint address change", async () => {
    const world = await seedWorld();
    const { issued, keyPem } = issueFor(world.node1.id);
    const first = await startTlsServer(issued.certPem, keyPem);
    await prisma.nodeAgentCertificate.create({
      data: {
        nodeId: world.node1.id, serialNumber: issued.serialNumber, fingerprintSha256: issued.fingerprintSha256,
        subjectIdentity: issued.identity, status: "ACTIVE", notBefore: issued.notBefore, notAfter: issued.notAfter
      }
    });
    let node = await prisma.node.update({
      where: { id: world.node1.id },
      data: { tlsApiBaseUrl: `https://127.0.0.1:${first.port}` }
    });
    expect((await secureFetch(node, { method: "GET", path: "/health" })).status).toBe(200);
    first.close();
    invalidateSecureAgent(world.node1.id);

    // Same certificate, different port/address — still valid (logical identity).
    const second = await startTlsServer(issued.certPem, keyPem);
    try {
      node = await prisma.node.update({
        where: { id: world.node1.id },
        data: { tlsApiBaseUrl: `https://127.0.0.1:${second.port}` }
      });
      expect((await secureFetch(node, { method: "GET", path: "/health" })).status).toBe(200);
    } finally {
      second.close();
      invalidateSecureAgent(world.node1.id);
    }
  });

  it("live verification succeeds only against the expected certificate", async () => {
    const world = await seedWorld();
    const { issued, keyPem } = issueFor(world.node1.id);
    const server = await startTlsServer(issued.certPem, keyPem);
    try {
      const node = await prisma.node.findUniqueOrThrow({ where: { id: world.node1.id } });
      const good = await verifyNodeTlsEndpoint(node, {
        baseUrlOverride: `https://127.0.0.1:${server.port}`,
        expectedFingerprint: issued.fingerprintSha256
      });
      expect(good.ok).toBe(true);

      const bad = await verifyNodeTlsEndpoint(node, {
        baseUrlOverride: `https://127.0.0.1:${server.port}`,
        expectedFingerprint: "f".repeat(64)
      });
      expect(bad.ok).toBe(false);
    } finally {
      server.close();
      invalidateSecureAgent(world.node1.id);
    }
  });
});

describe("execution eligibility gate", () => {
  it("transportMode alone does NOT authorize execution (no certificate)", async () => {
    const world = await seedWorld();
    const node = await prisma.node.update({
      where: { id: world.node1.id },
      data: { transportMode: "TLS_VERIFIED", tlsApiBaseUrl: "https://127.0.0.1:9999", composeSupported: true, composeVersion: "v2.40.3" }
    });
    const eligibility = await getManagedExecutionEligibility(node);
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.reasons).toContain("NO_ACTIVE_CERTIFICATE");
  });

  it("LEGACY_HTTP node is not eligible", async () => {
    const world = await seedWorld();
    const node = await prisma.node.update({
      where: { id: world.node1.id },
      data: { transportMode: "LEGACY_HTTP", composeSupported: true, composeVersion: "v2.40.3" }
    });
    const eligibility = await getManagedExecutionEligibility(node);
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.reasons).toContain("AGENT_TLS_NOT_VERIFIED");
    expect(eligibility.message).toMatch(/secure agent transport/);
  });

  it("fully-configured node is eligible", async () => {
    const world = await seedWorld();
    const { issued } = issueFor(world.node1.id);
    await prisma.nodeAgentCertificate.create({
      data: {
        nodeId: world.node1.id, serialNumber: issued.serialNumber, fingerprintSha256: issued.fingerprintSha256,
        subjectIdentity: issued.identity, status: "ACTIVE", notBefore: issued.notBefore, notAfter: issued.notAfter
      }
    });
    const node = await prisma.node.update({
      where: { id: world.node1.id },
      data: { transportMode: "TLS_VERIFIED", tlsApiBaseUrl: "https://127.0.0.1:9999", composeSupported: true, composeVersion: "v2.40.3" }
    });
    const eligibility = await getManagedExecutionEligibility(node);
    expect(eligibility.allowed).toBe(true);
    expect(eligibility.reasons).toHaveLength(0);
  });

  it("expired certificate makes the node ineligible", async () => {
    const world = await seedWorld();
    const { issued } = issueFor(world.node1.id);
    await prisma.nodeAgentCertificate.create({
      data: {
        nodeId: world.node1.id, serialNumber: issued.serialNumber, fingerprintSha256: issued.fingerprintSha256,
        subjectIdentity: issued.identity, status: "ACTIVE",
        notBefore: new Date(Date.now() - 10 * 86400000), notAfter: new Date(Date.now() - 86400000)
      }
    });
    const node = await prisma.node.update({
      where: { id: world.node1.id },
      data: { transportMode: "TLS_VERIFIED", tlsApiBaseUrl: "https://127.0.0.1:9999", composeSupported: true, composeVersion: "v2.40.3" }
    });
    const eligibility = await getManagedExecutionEligibility(node);
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.reasons).toContain("CERTIFICATE_EXPIRED");
  });
});

describe("no-downgrade guarantee", () => {
  it("managed mutation never falls back to HTTP when TLS fails", async () => {
    const world = await seedWorld();
    const { issued } = issueFor(world.node1.id);
    await prisma.nodeAgentCertificate.create({
      data: {
        nodeId: world.node1.id, serialNumber: issued.serialNumber, fingerprintSha256: issued.fingerprintSha256,
        subjectIdentity: issued.identity, status: "ACTIVE", notBefore: issued.notBefore, notAfter: issued.notAfter
      }
    });
    // Endpoint points at a closed port — TLS cannot be established.
    const node = await prisma.node.update({
      where: { id: world.node1.id },
      data: { transportMode: "TLS_VERIFIED", tlsApiBaseUrl: "https://127.0.0.1:1" }
    });

    // No plaintext retry: the call fails closed with a transport error.
    await expect(
      secureFetch(node, { method: "POST", path: "/deployments/x/apply", body: '{"secrets":{"A":"s"}}' })
    ).rejects.toBeInstanceOf(SecureTransportError);
  });

  it("secureFetch has no code path that constructs an http:// request", async () => {
    const src = fs.readFileSync("server/services/node-agent/secure-transport.ts", "utf8");
    // The module must never disable verification or build a plaintext request.
    expect(src).not.toMatch(/rejectUnauthorized:\s*false/);
    expect(src).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    expect(src).toMatch(/url\.protocol !== "https:"/);
  });

  it("the managed signed-mutation client routes through secureFetch only", async () => {
    const src = fs.readFileSync("server/services/node-agent/client.ts", "utf8");
    const signedFn = src.slice(src.indexOf("private async callSigned"), src.indexOf("async prepareDeployment"));
    expect(signedFn).toMatch(/secureFetch\(/);
    // No raw fetch()/http fallback inside the signed-mutation path.
    expect(signedFn).not.toMatch(/await fetch\(/);
  });
});
