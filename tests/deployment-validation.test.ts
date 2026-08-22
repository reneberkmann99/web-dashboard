import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { createDeployment, stripTransientProjectName, validateDeploymentDefinition } from "@/server/services/deployments";
import { createIngressEndpoint, createPublicAddress } from "@/server/services/ingress";

const { validateComposeMock } = vi.hoisted(() => ({ validateComposeMock: vi.fn() }));

vi.mock("@/server/services/node-agent/client", () => ({
  nodeAgentClient: { validateCompose: validateComposeMock }
}));

const VALID_COMPOSE = "services:\n  web:\n    image: nginx:stable\n";

function validAgent(normalized = VALID_COMPOSE) {
  return { composeSupported: true, composeVersion: "v2.39.4", valid: true, errors: [], normalized };
}

beforeAll(() => resetDatabase());

beforeEach(() => {
  validateComposeMock.mockReset();
  validateComposeMock.mockResolvedValue(validAgent());
});

describe("managed deployment validation + creation", () => {
  it("creates a managed definition (Project=COMPOSE, Deployment, Revision #1)", async () => {
    const world = await seedWorld();
    const result = await createDeployment({
      nodeId: world.node1.id,
      name: "My App",
      composeProjectName: "myapp",
      compose: VALID_COMPOSE,
      environment: {},
      secretReferences: [],
      acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: result.deploymentId } });
    const project = await prisma.project.findUniqueOrThrow({ where: { id: deployment.projectId } });
    expect(project.source).toBe("COMPOSE");
    expect(project.composeProject).toBe("myapp");
    expect(deployment.source).toBe("HOSTPANEL");
    expect(await prisma.deploymentRevision.count({ where: { deploymentId: deployment.id } })).toBe(1);
  });

  it("uses deterministic sentinels — never real secret values", async () => {
    const world = await seedWorld();
    const result = await createDeployment({
      nodeId: world.node1.id,
      name: "App",
      composeProjectName: "app2",
      compose: "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ${DB_PASSWORD}\n",
      environment: { APP_ENV: "production" },
      secretReferences: ["DB_PASSWORD"],
      acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(result.status).toBe("created");

    const call = validateComposeMock.mock.calls[0];
    const payload = call[1] as { compose: string; env: Record<string, string> };
    expect(payload.env.DB_PASSWORD).toBe("__HOSTPANEL_SECRET_DB_PASSWORD__");
    expect(payload.env.APP_ENV).toBe("production");
    // The compose sent for validation still carries the placeholder, not a value.
    expect(payload.compose).toContain("${DB_PASSWORD}");
    expect(JSON.stringify(payload)).not.toContain("REAL_SECRET_VALUE");
  });

  it("returns invalid for a Compose model the agent rejects", async () => {
    const world = await seedWorld();
    validateComposeMock.mockResolvedValue({
      composeSupported: true,
      composeVersion: "v2.39.4",
      valid: false,
      errors: ["services.web.image: field required"],
      normalized: null
    });
    const result = await createDeployment({
      nodeId: world.node1.id,
      name: "X",
      composeProjectName: "x1",
      compose: "services:\n  web:\n",
      environment: {},
      secretReferences: [],
      acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(result.status).toBe("invalid");
  });

  it("returns compose_unavailable when the node lacks Compose v2", async () => {
    const world = await seedWorld();
    validateComposeMock.mockResolvedValue({
      composeSupported: false,
      composeVersion: null,
      valid: false,
      errors: ["Docker Compose v2 is not available on this node."],
      normalized: null
    });
    const result = await createDeployment({
      nodeId: world.node1.id,
      name: "X",
      composeProjectName: "x2",
      compose: VALID_COMPOSE,
      environment: {},
      secretReferences: [],
      acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(result.status).toBe("compose_unavailable");
  });

  it("rejects secret interpolation outside environment values", async () => {
    const world = await seedWorld();
    const result = await createDeployment({
      nodeId: world.node1.id,
      name: "X",
      composeProjectName: "x3",
      compose: "services:\n  app:\n    image: ${DB_PASSWORD}\n",
      environment: {},
      secretReferences: ["DB_PASSWORD"],
      acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.findings.some((f) => f.ruleId === "secret-interpolation-outside-environment")).toBe(true);
    }
  });

  it("requires HIGH_RISK acknowledgement before saving", async () => {
    const world = await seedWorld();
    const result = await createDeployment({
      nodeId: world.node1.id,
      name: "X",
      composeProjectName: "x4",
      compose: "services:\n  app:\n    image: x\n    privileged: true\n",
      environment: {},
      secretReferences: [],
      acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(result.status).toBe("ack_required");
  });

  it("accepts an acknowledged HIGH_RISK finding", async () => {
    const world = await seedWorld();
    const compose = "services:\n  app:\n    image: x\n    privileged: true\n";
    const first = await createDeployment({
      nodeId: world.node1.id, name: "X", composeProjectName: "x5", compose,
      environment: {}, secretReferences: [], acknowledgedFindings: [], actor: sessionFor(world.adminA)
    });
    expect(first.status).toBe("ack_required");
    const fp = (first as { highRiskFindings: { fingerprint: string }[] }).highRiskFindings[0].fingerprint;

    const second = await createDeployment({
      nodeId: world.node1.id, name: "X", composeProjectName: "x6", compose,
      environment: {}, secretReferences: [], acknowledgedFindings: [fp], actor: sessionFor(world.adminA)
    });
    expect(second.status).toBe("created");
  });

  it("enforces compose project name uniqueness per node", async () => {
    const world = await seedWorld();
    await createDeployment({
      nodeId: world.node1.id, name: "A", composeProjectName: "dup", compose: VALID_COMPOSE,
      environment: {}, secretReferences: [], acknowledgedFindings: [], actor: sessionFor(world.adminA)
    });
    const second = await createDeployment({
      nodeId: world.node1.id, name: "B", composeProjectName: "dup", compose: VALID_COMPOSE,
      environment: {}, secretReferences: [], acknowledgedFindings: [], actor: sessionFor(world.adminA)
    });
    expect(second.status).toBe("compose_project_taken");
  });

  it("Phase 5: refuses to adopt an existing project into a different organization while it has a bound ingress endpoint", async () => {
    const world = await seedWorld();
    const composeProjectName = `adopt-${Date.now()}`;
    const ingressCompose = "services:\n  web:\n    image: nginx:stable\n    expose: [\"8600\"]\n";
    validateComposeMock.mockResolvedValue(validAgent(ingressCompose));
    const created = await createDeployment({
      nodeId: world.node1.id, name: "Adopt target", composeProjectName, compose: ingressCompose,
      environment: {}, secretReferences: [], acknowledgedFindings: [], clientAccountId: world.clientA.id, actor: sessionFor(world.adminA)
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;

    const address = await createPublicAddress({ label: "Adopt guard test", ipAddress: "203.0.113.180", ipVersion: "V4", actor: sessionFor(world.adminA) });
    await createIngressEndpoint({
      workloadId: created.projectId, serviceName: "web", targetPort: 8600, exposureType: "TCP", publicAddressId: address.id, publicPort: 28600,
      clientAccountId: world.clientA.id, actor: sessionFor(world.adminA)
    });

    await expect(createDeployment({
      nodeId: world.node1.id, name: "Adopt target", composeProjectName, compose: VALID_COMPOSE,
      environment: {}, secretReferences: [], acknowledgedFindings: [], adoptExistingProjectId: created.projectId,
      clientAccountId: world.clientB.id, actor: sessionFor(world.adminA)
    })).rejects.toThrow("WORKLOAD_HAS_INGRESS_ENDPOINT");
  });

  it("standalone validate endpoint logic returns findings without persisting", async () => {
    const world = await seedWorld();
    const before = await prisma.deployment.count();
    const result = await validateDeploymentDefinition({
      nodeId: world.node1.id,
      compose: "services:\n  app:\n    image: ${DB_PASSWORD}\n",
      environment: {},
      secretReferences: ["DB_PASSWORD"]
    });
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.ruleId === "secret-interpolation-outside-environment")).toBe(true);
    expect(await prisma.deployment.count()).toBe(before);
  });
});

describe("stripTransientProjectName", () => {
  it("removes the baked-in project name and derived network/volume names", () => {
    const normalized = [
      "name: hostpanel-compose-dhehfo",
      "services:",
      "  app:",
      "    image: alpine:3.20",
      "networks:",
      "  default:",
      "    name: hostpanel-compose-dhehfo_default",
      "volumes:",
      "  data:",
      "    name: hostpanel-compose-dhehfo_data",
      ""
    ].join("\n");

    const out = stripTransientProjectName(normalized);

    expect(out).not.toContain("hostpanel-compose-dhehfo");
    expect(out).toContain("image: alpine:3.20");
    expect(out).toContain("networks:");
    expect(out).toContain("volumes:");
  });

  it("leaves user-authored top-level keys intact", () => {
    const normalized = [
      "name: hostpanel-compose-x",
      "services:",
      "  web:",
      "    image: nginx:stable",
      "    ports:",
      "      - \"8080:80\"",
      ""
    ].join("\n");
    const out = stripTransientProjectName(normalized);
    expect(out).toContain("image: nginx:stable");
    expect(out).toContain("8080:80");
    expect(out).not.toContain("hostpanel-compose-x");
  });
});
