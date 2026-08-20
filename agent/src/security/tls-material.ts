import fs from "node:fs";
import path from "node:path";
import forge from "node-forge";
import { resolveStateDir } from "../deployments/state-dir";

/**
 * Agent-side TLS material (Phase 6B.1).
 *
 * The agent generates its OWN private key locally and never transmits it. Only
 * a CSR leaves the node. Files live under the rootless-aware state directory:
 *
 *   <AGENT_STATE_DIR>/pki/agent-key.pem            0600
 *   <AGENT_STATE_DIR>/pki/agent-cert.pem           0600
 *   <AGENT_STATE_DIR>/pki/hostpanel-agent-ca.pem   0644
 *
 * A "candidate" key/cert pair is staged during rotation and only promoted once
 * the control plane has verified the new endpoint.
 */

export function pkiDir(): string {
  return path.join(resolveStateDir(), "pki");
}

const KEY_FILE = "agent-key.pem";
const CERT_FILE = "agent-cert.pem";
const CA_FILE = "hostpanel-agent-ca.pem";
const CANDIDATE_KEY_FILE = "agent-key.candidate.pem";
const CANDIDATE_CERT_FILE = "agent-cert.candidate.pem";

function p(file: string): string {
  return path.join(pkiDir(), file);
}

export function hasActiveTlsMaterial(): boolean {
  try {
    return fs.existsSync(p(KEY_FILE)) && fs.existsSync(p(CERT_FILE)) && fs.existsSync(p(CA_FILE));
  } catch {
    return false;
  }
}

export function readTlsMaterial(): { key: string; cert: string; ca: string } | null {
  try {
    return {
      key: fs.readFileSync(p(KEY_FILE), "utf8"),
      cert: fs.readFileSync(p(CERT_FILE), "utf8"),
      ca: fs.readFileSync(p(CA_FILE), "utf8")
    };
  } catch {
    return null;
  }
}

/**
 * Generate a fresh keypair + CSR locally. The CSR subject is a placeholder —
 * the control plane ignores it and assigns the Noderaft-controlled identity.
 * The private key is written as a CANDIDATE and only promoted after the
 * control plane verifies the issued certificate works.
 */
export function generateKeyAndCsr(): { csrPem: string } {
  fs.mkdirSync(pkiDir(), { recursive: true, mode: 0o700 });
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: "commonName", value: "hostpanel-agent" }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());

  fs.writeFileSync(p(CANDIDATE_KEY_FILE), forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  return { csrPem: forge.pki.certificationRequestToPem(csr) };
}

/** Stage an issued certificate + CA alongside the candidate key. */
export function stageCertificate(certPem: string, caPem: string): void {
  fs.mkdirSync(pkiDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p(CANDIDATE_CERT_FILE), certPem, { mode: 0o600 });
  fs.writeFileSync(p(CA_FILE), caPem, { mode: 0o644 });
}

/**
 * Promote the staged candidate to active. Called immediately after staging so
 * the HTTPS listener can serve the new certificate for control-plane
 * verification; the control plane only marks the node verified after a real
 * verified request succeeds against it.
 */
export function promoteCandidate(): boolean {
  try {
    if (!fs.existsSync(p(CANDIDATE_KEY_FILE)) || !fs.existsSync(p(CANDIDATE_CERT_FILE))) return false;
    fs.renameSync(p(CANDIDATE_KEY_FILE), p(KEY_FILE));
    fs.renameSync(p(CANDIDATE_CERT_FILE), p(CERT_FILE));
    fs.chmodSync(p(KEY_FILE), 0o600);
    fs.chmodSync(p(CERT_FILE), 0o600);
    return true;
  } catch {
    return false;
  }
}

export function discardCandidate(): void {
  for (const f of [CANDIDATE_KEY_FILE, CANDIDATE_CERT_FILE]) {
    try {
      fs.unlinkSync(p(f));
    } catch {
      /* ignore */
    }
  }
}
