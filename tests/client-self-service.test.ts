import { beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { createDeployment, validateDeploymentDefinition } from "@/server/services/deployments";
import { setClientNodeAccess, listAllowedNodesForClient } from "@/server/services/client-nodes";
import { analyzeComposeDefinition, CLIENT_BLOCKED_RULES } from "@/server/services/deployment-security";
import { requireClientDeployment, getClientDeployment } from "@/server/services/client-deployments";

const { validateComposeMock } = vi.hoisted(() => ({ validateComposeMock: vi.fn() }));
vi.mock("@/server/services/node-agent/client", () => ({
  nodeAgentClient: { validateCompose: validateComposeMock }
}));

beforeAll(() => resetDatabase());

const VALID = "services:\n  web:\n    image: nginx:stable\n";

function stubAgent(normalized = VALID) {
  validateComposeMock.mockResolvedValue({ composeSupported: true, composeVersion: "v2.39.4", valid: true, errors: [], normalized });
}

describe("Phase 7: strict CLIENT security policy", () => {
  it("privileged/host-bind/socket/host-net/pid/caps/devices/security-opt/sysctls/external-* escalate to BLOCKED under CLIENT policy", () => {
    const cases: Array<{ compose: string; ruleId: string }> = [
      { compose: "services:\n  a:\n    image: x\n    privileged: true\n", ruleId: "privileged" },
      { compose: "services:\n  a:\n    image: x\n    network_mode: host\n", ruleId: "host-networking" },
      { compose: "services:\n  a:\n    image: x\n    pid: host\n", ruleId: "pid-host" },
      { compose: "services:\n  a:\n    image: x\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n", ruleId: "docker-socket-mount" },
      { compose: "services:\n  a:\n    image: x\n    volumes:\n      - /etc:/host-etc\n", ruleId: "sensitive-host-bind" },
      { compose: "services:\n  a:\n    image: x\n    cap_add:\n      - SYS_ADMIN\n", ruleId: "cap-add" },
      { compose: "services:\n  a:\n    image: x\n    devices:\n      - /dev/sda:/dev/sda\n", ruleId: "devices" },
      { compose: "services:\n  a:\n    image: x\n    security_opt:\n      - seccomp:unconfined\n", ruleId: "security-opt" },
      { compose: "services:\n  a:\n    image: x\n    sysctls:\n      net.core.somaxconn: 1024\n", ruleId: "sysctls" },
      { compose: "services:\n  a:\n    image: x\nnetworks:\n  ext:\n    external: true\n", ruleId: "external-networks" },
      { compose: "services:\n  a:\n    image: x\nvolumes:\n  ext:\n    external: true\n", ruleId: "external-volumes" }
    ];

    for (const { compose, ruleId } of cases) {
      const adminResult = analyzeComposeDefinition({ composeSource: compose, secretReferences: [], policy: "ADMIN" });
      const adminFinding = adminResult.findings.find((f) => f.ruleId === ruleId);
      expect(adminFinding, `admin finding for ${ruleId}`).toBeDefined();
      expect(adminFinding!.severity).not.toBe("BLOCKED"); // admin: HIGH_RISK (or WARNING), acknowledgeable

      const clientResult = analyzeComposeDefinition({ composeSource: compose, secretReferences: [], policy: "CLIENT" });
      const clientFinding = clientResult.findings.find((f) => f.ruleId === ruleId);
      expect(clientFinding, `client finding for ${ruleId}`).toBeDefined();
      expect(clientFinding!.severity).toBe("BLOCKED"); // client: never acknowledgeable
    }
  });

  it("CLIENT_BLOCKED_RULES set is non-empty and used consistently", () => {
    expect(CLIENT_BLOCKED_RULES.size).toBeGreaterThan(0);
    expect(CLIENT_BLOCKED_RULES.has("privileged")).toBe(true);
    expect(CLIENT_BLOCKED_RULES.has("docker-socket-mount")).toBe(true);
  });

  it("createDeployment under CLIENT policy rejects a privileged container outright (invalid, not ack_required)", async () => {
    stubAgent();
    const world = await seedWorld();
    const suffix = crypto.randomUUID().slice(0, 8);
    const result = await createDeployment({
      nodeId: world.node1.id,
      name: `Priv ${suffix}`,
      composeProjectName: `priv-${suffix}`,
      compose: "services:\n  a:\n    image: nginx:stable\n    privileged: true\n",
      environment: {},
      secretReferences: [],
      acknowledgedFindings: [],
      policy: "CLIENT",
      clientAccountId: world.clientA.id,
      actor: sessionFor(world.clientAOperator)
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.findings.some((f) => f.ruleId === "privileged" && f.severity === "BLOCKED")).toBe(true);
    }
  });

  it("createDeployment under CLIENT policy succeeds for a benign compose and persists policy=CLIENT", async () => {
    stubAgent();
    const world = await seedWorld();
    const suffix = crypto.randomUUID().slice(0, 8);
    const result = await createDeployment({
      nodeId: world.node1.id,
      name: `OK ${suffix}`,
      composeProjectName: `ok-${suffix}`,
      compose: VALID,
      environment: {},
      secretReferences: [],
      acknowledgedFindings: [],
      policy: "CLIENT",
      clientAccountId: world.clientA.id,
      actor: sessionFor(world.clientAOperator)
    });
    expect(result.status).toBe("created");
    if (result.status === "created") {
      const rev = await prisma.deploymentRevision.findUniqueOrThrow({ where: { id: result.revisionId } });
      expect(rev.policy).toBe("CLIENT");
    }
  });

  it("acknowledging a BLOCKED finding does not bypass CLIENT policy", async () => {
    stubAgent();
    const world = await seedWorld();
    const suffix = crypto.randomUUID().slice(0, 8);
    const compose = "services:\n  a:\n    image: nginx:stable\n    privileged: true\n";
    const analyzed = analyzeComposeDefinition({ composeSource: compose, secretReferences: [], policy: "CLIENT" });
    const blockedFingerprint = analyzed.findings.find((f) => f.ruleId === "privileged")!.fingerprint;

    const result = await createDeployment({
      nodeId: world.node1.id,
      name: `Bypass ${suffix}`,
      composeProjectName: `bypass-${suffix}`,
      compose,
      environment: {},
      secretReferences: [],
      acknowledgedFindings: [blockedFingerprint],
      policy: "CLIENT",
      clientAccountId: world.clientA.id,
      actor: sessionFor(world.clientAOperator)
    });
    expect(result.status).toBe("invalid");
  });

  it("ADMIN policy still allows the same configuration with acknowledgement (regression guard)", async () => {
    stubAgent();
    const world = await seedWorld();
    const suffix = crypto.randomUUID().slice(0, 8);
    const compose = "services:\n  a:\n    image: nginx:stable\n    privileged: true\n";
    const analyzed = analyzeComposeDefinition({ composeSource: compose, secretReferences: [], policy: "ADMIN" });
    const fp = analyzed.findings.find((f) => f.ruleId === "privileged")!.fingerprint;

    const result = await createDeployment({
      nodeId: world.node1.id,
      name: `Admin Priv ${suffix}`,
      composeProjectName: `admin-priv-${suffix}`,
      compose,
      environment: {},
      secretReferences: [],
      acknowledgedFindings: [fp],
      actor: sessionFor(world.adminA)
    });
    expect(result.status).toBe("created");
  });
});

describe("Phase 7: node allowlist", () => {
  it("client with no allowlist entries has zero allowed nodes", async () => {
    const world = await seedWorld();
    expect(await listAllowedNodesForClient(world.clientA.id)).toEqual([]);
  });

  it("admin can grant + revoke node access; listAllowedNodesForClient reflects it", async () => {
    const world = await seedWorld();
    const set1 = await setClientNodeAccess({ clientAccountId: world.clientA.id, nodeIds: [world.node1.id], actor: sessionFor(world.adminA) });
    expect(set1.status).toBe("updated");
    let allowed = await listAllowedNodesForClient(world.clientA.id);
    expect(allowed.map((n) => n.nodeId)).toEqual([world.node1.id]);

    const set2 = await setClientNodeAccess({ clientAccountId: world.clientA.id, nodeIds: [], actor: sessionFor(world.adminA) });
    expect(set2.status).toBe("updated");
    allowed = await listAllowedNodesForClient(world.clientA.id);
    expect(allowed).toEqual([]);
  });

  it("setClientNodeAccess rejects an unknown node id", async () => {
    const world = await seedWorld();
    const result = await setClientNodeAccess({ clientAccountId: world.clientA.id, nodeIds: ["nonexistent-node-id"], actor: sessionFor(world.adminA) });
    expect(result.status).toBe("node_not_found");
  });

  it("allowlist for one client does not leak to another client", async () => {
    const world = await seedWorld();
    await setClientNodeAccess({ clientAccountId: world.clientA.id, nodeIds: [world.node1.id], actor: sessionFor(world.adminA) });
    expect(await listAllowedNodesForClient(world.clientB.id)).toEqual([]);
  });

  it("listAllowedNodesForClient excludes a node the client was never granted", async () => {
    const world = await seedWorld();
    await setClientNodeAccess({ clientAccountId: world.clientA.id, nodeIds: [world.node1.id], actor: sessionFor(world.adminA) });
    const allowed = await listAllowedNodesForClient(world.clientA.id);
    expect(allowed.some((n) => n.nodeId === world.node2.id)).toBe(false);
    expect(allowed.some((n) => n.nodeId === world.node1.id)).toBe(true);
  });
});

describe("Phase 7: client deployment tenant isolation", () => {
  async function managedWorkloadFor(clientId: string, nodeId: string, adminSession: ReturnType<typeof sessionFor>) {
    const suffix = crypto.randomUUID().slice(0, 8);
    stubAgent();
    const result = await createDeployment({
      nodeId,
      name: `Tenant ${suffix}`,
      composeProjectName: `tenant-${suffix}`,
      compose: VALID,
      environment: {},
      secretReferences: [],
      acknowledgedFindings: [],
      policy: "CLIENT",
      clientAccountId: clientId,
      actor: adminSession
    });
    if (result.status !== "created") throw new Error(`seed failed: ${result.status}`);
    return result;
  }

  it("owning client can access their own deployment via requireClientDeployment", async () => {
    const world = await seedWorld();
    const created = await managedWorkloadFor(world.clientA.id, world.node1.id, sessionFor(world.clientAOperator));
    const ctx = await requireClientDeployment(sessionFor(world.clientAOperator), created.deploymentId, "deployment.view");
    expect(ctx.deploymentId).toBe(created.deploymentId);
  });

  it("a different client cannot access another tenant's deployment (getClientDeployment returns null)", async () => {
    const world = await seedWorld();
    const created = await managedWorkloadFor(world.clientA.id, world.node1.id, sessionFor(world.clientAOperator));
    const ctx = await getClientDeployment(sessionFor(world.clientBOperator), created.deploymentId, "deployment.view");
    expect(ctx).toBeNull();
  });

  it("requireClientDeployment throws NOT_FOUND for cross-tenant access (never leaks existence via a different error)", async () => {
    const world = await seedWorld();
    const created = await managedWorkloadFor(world.clientA.id, world.node1.id, sessionFor(world.clientAOperator));
    await expect(requireClientDeployment(sessionFor(world.clientBOperator), created.deploymentId, "deployment.view")).rejects.toThrow("NOT_FOUND");
  });

  it("CLIENT_VIEWER (view-only capability) fails ensureCan for deployment.manage even when owning the deployment", async () => {
    const world = await seedWorld();
    const created = await managedWorkloadFor(world.clientA.id, world.node1.id, sessionFor(world.clientAOperator));
    await expect(requireClientDeployment(sessionFor(world.clientAViewer), created.deploymentId, "deployment.manage")).rejects.toThrow("FORBIDDEN");
    const ctx = await getClientDeployment(sessionFor(world.clientAViewer), created.deploymentId, "deployment.view");
    expect(ctx?.deploymentId).toBe(created.deploymentId);
  });

  it("nonexistent deployment id returns null / throws NOT_FOUND, not an internal error", async () => {
    const world = await seedWorld();
    expect(await getClientDeployment(sessionFor(world.clientAOperator), "nonexistent-id", "deployment.view")).toBeNull();
    await expect(requireClientDeployment(sessionFor(world.clientAOperator), "nonexistent-id", "deployment.view")).rejects.toThrow("NOT_FOUND");
  });

  it("validateDeploymentDefinition honors the CLIENT policy flag end-to-end", async () => {
    stubAgent();
    const world = await seedWorld();
    await setClientNodeAccess({ clientAccountId: world.clientA.id, nodeIds: [world.node1.id], actor: sessionFor(world.adminA) });
    const result = await validateDeploymentDefinition({
      nodeId: world.node1.id,
      compose: "services:\n  a:\n    image: nginx:stable\n    privileged: true\n",
      environment: {},
      secretReferences: [],
      policy: "CLIENT"
    });
    expect(result.valid).toBe(false);
    expect(result.blockedFindings.some((f) => f.ruleId === "privileged")).toBe(true);
  });
});
