import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import forge from "node-forge";

// Point the PKI at a throwaway directory BEFORE importing the module.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hostpanel-pki-test-"));
process.env.HOSTPANEL_AGENT_CA_CERT_PATH = path.join(tmpDir, "ca.pem");
process.env.HOSTPANEL_AGENT_CA_KEY_PATH = path.join(tmpDir, "ca-key.pem");

const {
  bootstrapCa,
  caExists,
  signNodeCsr,
  nodeIdentity,
  fingerprintFromPem,
  serialFromPem,
  daysUntil,
  readCaCertPem
} = await import("@/server/security/agent-pki");

function makeCsr(subjectCn = "attacker-chosen", extraSan?: string): string {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: "commonName", value: subjectCn }]);
  if (extraSan) {
    csr.setAttributes([
      {
        name: "extensionRequest",
        extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: extraSan }] }]
      }
    ]);
  }
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

beforeAll(() => {
  if (!caExists()) bootstrapCa({ years: 1 });
});

describe("HostPanel Agent PKI", () => {
  it("bootstraps a CA and refuses to overwrite it", () => {
    expect(caExists()).toBe(true);
    expect(() => bootstrapCa()).toThrow(/already exists/i);
    // CA private key must be 0600.
    const mode = fs.statSync(process.env.HOSTPANEL_AGENT_CA_KEY_PATH!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("signs a node CSR with a HostPanel-controlled identity", () => {
    const nodeId = "cnode000000000000000000001";
    const issued = signNodeCsr({ nodeId, csrPem: makeCsr() });
    const cert = forge.pki.certificateFromPem(issued.certPem);

    expect(issued.identity).toBe(nodeIdentity(nodeId));
    expect(cert.subject.getField("CN").value).toBe(nodeIdentity(nodeId));

    const san = cert.getExtension("subjectAltName") as { altNames?: { type: number; value: string }[] } | undefined;
    const names = (san?.altNames ?? []).map((a) => a.value);
    expect(names).toEqual([nodeIdentity(nodeId)]);
  });

  it("IGNORES CSR-requested subject and SANs (no attacker-chosen identity)", () => {
    const nodeId = "cnode000000000000000000002";
    const issued = signNodeCsr({
      nodeId,
      csrPem: makeCsr("evil.example.com", "other-node.agents.hostpanel.internal")
    });
    const cert = forge.pki.certificateFromPem(issued.certPem);
    const san = cert.getExtension("subjectAltName") as { altNames?: { type: number; value: string }[] } | undefined;
    const names = (san?.altNames ?? []).map((a) => a.value);

    expect(cert.subject.getField("CN").value).not.toBe("evil.example.com");
    expect(names).not.toContain("other-node.agents.hostpanel.internal");
    expect(names).toEqual([nodeIdentity(nodeId)]);
  });

  it("issued certificates chain to the HostPanel CA", () => {
    const issued = signNodeCsr({ nodeId: "cnode000000000000000000003", csrPem: makeCsr() });
    const caStore = forge.pki.createCaStore([readCaCertPem()]);
    const cert = forge.pki.certificateFromPem(issued.certPem);
    expect(() => forge.pki.verifyCertificateChain(caStore, [cert])).not.toThrow();
  });

  it("rejects a malformed CSR cleanly", () => {
    expect(() => signNodeCsr({ nodeId: "cnode000000000000000000004", csrPem: "not-a-csr" })).toThrow(/INVALID_CSR/);
  });

  it("rejects an oversized CSR (bounded parsing surface)", () => {
    expect(() =>
      signNodeCsr({ nodeId: "cnode000000000000000000005", csrPem: "x".repeat(20000) })
    ).toThrow(/too large/i);
  });

  it("issues bounded-lifetime certificates (not effectively permanent)", () => {
    const issued = signNodeCsr({ nodeId: "cnode000000000000000000006", csrPem: makeCsr(), lifetimeDays: 90 });
    const days = daysUntil(issued.notAfter);
    expect(days).toBeGreaterThan(80);
    expect(days).toBeLessThanOrEqual(90);
  });

  it("produces unique serials and fingerprints per issuance", () => {
    const a = signNodeCsr({ nodeId: "cnode000000000000000000007", csrPem: makeCsr() });
    const b = signNodeCsr({ nodeId: "cnode000000000000000000007", csrPem: makeCsr() });
    expect(a.serialNumber).not.toBe(b.serialNumber);
    expect(a.fingerprintSha256).not.toBe(b.fingerprintSha256);
    expect(fingerprintFromPem(a.certPem)).toBe(a.fingerprintSha256);
    expect(serialFromPem(a.certPem)).toBe(a.serialNumber);
  });

  it("node identity is stable and unique per node (endpoint-independent)", () => {
    expect(nodeIdentity("abc")).toBe("node-abc.agents.hostpanel.internal");
    expect(nodeIdentity("abc")).not.toBe(nodeIdentity("abd"));
  });
});
