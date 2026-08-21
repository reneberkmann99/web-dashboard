import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { parse } from "yaml";
import { DeploymentSource, ProjectSource, Role } from "@prisma/client";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import { previewContainerAdoption, adoptContainer, synthesizeComposeFromInspect } from "@/server/services/container-adoption";

beforeAll(async () => {
  resetDatabase();
});

/**
 * Manual standalone-container adoption (Section 3).
 *
 * The adoption path must:
 *   - inspect the REAL container (agent) and synthesize a compose definition
 *     that reproduces it;
 *   - NEVER recreate / stop / restart the container at adoption time (the only
 *     Docker mutation is label-add, which cannot restart);
 *   - mark the runtime CONVERGED (it already matches);
 *   - refuse adoption on BLOCKERs;
 *   - declare named volumes and networks external so they can never be
 *     deleted by Noderaft.
 */

function makeInspect(overrides: Record<string, unknown> = {}) {
  return {
    Id: "abc123def456abc123def456abc123def456abc123def456abc123def456ab12",
    Name: "/e2e-adopt-nginx",
    Created: "2026-08-01T10:00:00Z",
    State: { Running: true, StartedAt: "2026-08-01T10:00:01Z", Status: "running" },
    Config: {
      Hostname: "abc123def456",
      User: "",
      Env: ["NGINX_PORT=8080", "API_KEY=supersecret"],
      Cmd: ["nginx", "-g", "daemon off;"],
      Image: "nginx:1.27-alpine",
      WorkingDir: "",
      Entrypoint: [],
      Labels: { "com.example.owner": "platform" },
      ExposedPorts: { "80/tcp": {}, "443/tcp": {} },
      Healthcheck: {
        Test: ["CMD-SHELL", "wget -q --spider http://localhost/ || exit 1"],
        Interval: 30000000000,
        Timeout: 3000000000,
        Retries: 3,
        StartPeriod: 5000000000
      }
    },
    HostConfig: {
      Binds: null,
      PortBindings: {
        "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }]
      },
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Memory: 536870912,
      NanoCpus: 500000000,
      Privileged: false,
      ReadonlyRootfs: false,
      CapAdd: null,
      CapDrop: ["ALL"],
      Dns: ["1.1.1.1"],
      DnsSearch: null,
      Devices: null,
      Ulimits: null,
      Sysctls: null,
      SecurityOpt: null,
      NetworkMode: "default",
      PidMode: "",
      IpcMode: "",
      ShmSize: 0,
      LogConfig: { Type: "json-file", Config: {} },
      Tmpfs: null
    },
    Mounts: [
      { Type: "volume", Source: "/var/lib/docker/volumes/nginx-data/_data", Destination: "/usr/share/nginx/html", Mode: "", RW: true, Name: "nginx-data" },
      { Type: "bind", Source: "/srv/host/config", Destination: "/etc/nginx/conf.d", Mode: "ro", RW: false }
    ],
    NetworkSettings: {
      Networks: {
        bridge: { Aliases: ["e2e-adopt-nginx"], IPAddress: "172.17.0.2", Gateway: "172.17.0.1", NetworkID: "net1" },
        "shared-net": { Aliases: ["e2e-adopt-nginx", "web-alias"], IPAddress: "172.18.0.2", Gateway: "172.18.0.1", NetworkID: "net2" }
      }
    },
    ...overrides
  } as Record<string, unknown>;
}

/**
 * Real flow: the agent reports inventory first, so a Container row already
 * exists before adoption is offered. Tests must mirror that.
 */
async function seedInventoryRow(
  nodeId: string,
  dockerContainerId = "abc123def456",
  dockerName = "e2e-adopt-nginx"
): Promise<void> {
  await prisma.container.create({
    data: {
      nodeId,
      dockerContainerId,
      dockerName,
      image: "nginx:1.27-alpine",
      lastKnownStatus: "running",
      isActive: true
    }
  });
}

function stubAgent(inspect: Record<string, unknown> | null, labelResult = true): void {
  vi.spyOn(nodeAgentClient, "inspectContainerFull").mockImplementation(
    async () => ({ nodeOnline: true, inspect: inspect ?? null }) as never
  );
  vi.spyOn(nodeAgentClient, "validateCompose").mockImplementation(async (_node, input) => ({
    nodeOnline: true,
    composeSupported: true,
    composeVersion: "v2.30.0",
    valid: true,
    errors: [],
    normalized: input.compose
  }));
  vi.spyOn(nodeAgentClient, "labelContainer").mockImplementation(async () => labelResult);
  // Adoption must never invoke these:
  vi.spyOn(nodeAgentClient, "removeContainer").mockImplementation(async () => {
    throw new Error("removeContainer must not be called during adoption");
  });
  vi.spyOn(nodeAgentClient, "runAction").mockImplementation(async () => {
    throw new Error("runAction must not be called during adoption");
  });
}

describe("adoption compose synthesis", () => {
  it("reproduces image, command, ports, env, volumes, networks, healthcheck, resources, labels", () => {
    const { compose, fields } = synthesizeComposeFromInspect(
      makeInspect() as never,
      "e2e-adopt-nginx",
      "e2e-adopt-nginx-abc123"
    );
    const root = parse(compose) as {
      services: Record<string, Record<string, unknown>>;
      networks: Record<string, unknown>;
      volumes: Record<string, unknown>;
    };
    const svc = Object.values(root.services)[0];

    expect(svc.image).toBe("nginx:1.27-alpine");
    expect(svc.container_name).toBe("e2e-adopt-nginx");
    expect(svc.command).toEqual(["nginx", "-g", "daemon off;"]);
    expect(svc.restart).toBe("unless-stopped");
    expect(svc.cap_drop).toEqual(["ALL"]);
    expect(svc.ports).toEqual(["0.0.0.0:8080:80/tcp"]);
    expect(svc.environment).toEqual(["NGINX_PORT=8080", "API_KEY=supersecret"]);
    expect(svc.volumes).toContain("nginx-data:/usr/share/nginx/html");
    expect(svc.volumes).toContain("/srv/host/config:/etc/nginx/conf.d:ro");
    expect((svc.healthcheck as Record<string, unknown>).interval).toBe("30s");
    expect((svc.healthcheck as Record<string, unknown>).test).toEqual(["CMD-SHELL", "wget -q --spider http://localhost/ || exit 1"]);
    expect((svc.deploy as Record<string, Record<string, unknown>>).resources.limits).toEqual({ memory: 536870912, cpus: "0.5" });
    expect(svc.dns).toEqual(["1.1.1.1"]);
    expect(svc.labels).toEqual({ "com.example.owner": "platform" });

    // External network + external volume declarations (never deletable).
    // Docker's built-in `bridge` network is deliberately NOT declared (compose
    // rejects network-scoped aliases on built-ins); only user-defined networks
    // are reproduced as external.
    expect(root.networks).toEqual({ "shared-net": { external: true } });
    expect(root.volumes).toEqual({ "nginx-data": { external: true } });
    expect(svc.networks).toEqual({ "shared-net": { aliases: ["web-alias"] } });

    // Verdicts: bind mounts + plaintext env are WARNINGs, not blockers.
    const bind = fields.find((f) => f.field === "volumes");
    expect(bind?.verdict).toBe("WARNING");
    const env = fields.find((f) => f.field === "environment");
    expect(env?.verdict).toBe("WARNING");
  });

  it("maps host networking into network_mode (preserved, not dropped)", () => {
    const inspect = makeInspect({ HostConfig: { ...(makeInspect().HostConfig as Record<string, unknown>), NetworkMode: "host" } });
    const { compose } = synthesizeComposeFromInspect(inspect as never, "hosty", "hosty-1");
    const root = parse(compose) as { services: Record<string, Record<string, unknown>> };
    const svc = Object.values(root.services)[0];
    expect(svc.network_mode).toBe("host");
  });

  it("keeps the compose name/service stable and compose-valid", () => {
    const { compose } = synthesizeComposeFromInspect(makeInspect() as never, "my-app-1", "my-app-1-abc");
    const root = parse(compose) as { services: Record<string, unknown> };
    expect(Object.keys(root.services)).toHaveLength(1);
  });
});

describe("adoption preflight", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reports PASS/WARNING/BLOCKER verdicts and never mutates anything", async () => {
    stubAgent(makeInspect());
    const world = await seedWorld();
    const preview = await previewContainerAdoption(world.node1.id, "abc123def456");

    expect(preview).not.toBeNull();
    expect(preview?.dockerName).toBe("e2e-adopt-nginx");
    expect(preview?.blockers).toEqual([]);
    expect(preview?.warnings.length).toBeGreaterThan(0);
    expect(preview?.compose).toContain("nginx:1.27-alpine");
    expect(preview?.alreadyManaged).toBe(false);
    // Read-only: no docker mutation calls at all.
    expect(nodeAgentClient.removeContainer).not.toHaveBeenCalled();
    expect(nodeAgentClient.runAction).not.toHaveBeenCalled();
    expect(nodeAgentClient.labelContainer).not.toHaveBeenCalled();
  });

  it("blocks when the container already belongs to a workload", async () => {
    stubAgent(makeInspect());
    const world = await seedWorld();
    const preview = await previewContainerAdoption(world.node1.id, world.web.dockerContainerId);
    expect(preview?.alreadyManaged).toBe(true);
    expect(preview?.existingWorkloadName).toBe("Web Stack");
  });

  it("blocks container:<id> network namespace sharing", async () => {
    const inspect = makeInspect({ HostConfig: { ...(makeInspect().HostConfig as Record<string, unknown>), NetworkMode: "container:other-container" } });
    stubAgent(inspect);
    const world = await seedWorld();
    const preview = await previewContainerAdoption(world.node1.id, "abc123def456");
    expect(preview?.blockers.some((b) => b.field === "network_mode")).toBe(true);
  });
});

describe("adoption", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the workload/deployment/revision, associates the container, marks CONVERGED, and never recreates", async () => {
    stubAgent(makeInspect());
    const world = await seedWorld();
    await seedInventoryRow(world.node1.id);

    // The synthesized definition can carry HIGH_RISK findings (e.g. a secret-
    // looking env value like API_KEY in the inspected env); the real UI flow
    // shows the preview and requires explicit acknowledgement first.
    const preview = await previewContainerAdoption(world.node1.id, "abc123def456");
    const ackFingerprints = (preview?.highRiskFindings ?? []).map((f) => f.fingerprint ?? "");

    const result = await adoptContainer({
      nodeId: world.node1.id,
      dockerContainerId: "abc123def456",
      name: "Adopted Nginx",
      acknowledgedFindings: ackFingerprints,
      actor: sessionFor(world.adminA),
      sourceIp: "10.0.0.1"
    });

    expect(result.status).toBe("adopted");
    if (result.status !== "adopted") return;
    expect(result.labelsApplied).toBe(true);

    const project = await prisma.project.findUniqueOrThrow({ where: { id: result.projectId } });
    expect(project.name).toBe("Adopted Nginx");
    expect(project.source).toBe(ProjectSource.COMPOSE);
    expect(project.isActive).toBe(true);

    const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: result.deploymentId } });
    expect(deployment.runtimeState).toBe("CONVERGED");
    expect(deployment.source).toBe(DeploymentSource.HOSTPANEL);

    const revision = await prisma.deploymentRevision.findUniqueOrThrow({ where: { id: result.revisionId } });
    expect(revision.revisionNumber).toBe(1);
    expect(revision.composeSource).toContain("nginx:1.27-alpine");
    expect(revision.composeSource).toContain("container_name: e2e-adopt-nginx");

    const container = await prisma.container.findUniqueOrThrow({
      where: { nodeId_dockerContainerId: { nodeId: world.node1.id, dockerContainerId: "abc123def456" } }
    });
    expect(container.projectId).toBe(result.projectId);
    expect(container.composeProject).toBe(deployment.composeProjectName);

    // The ONLY docker mutation allowed at adoption is label-add (cannot
    // restart a container). remove/runAction are fatal if called.
    expect(nodeAgentClient.removeContainer).not.toHaveBeenCalled();
    expect(nodeAgentClient.runAction).not.toHaveBeenCalled();
    expect(nodeAgentClient.labelContainer).toHaveBeenCalledTimes(1);
  });

  it("requires acknowledgement for high-risk findings and refuses otherwise", async () => {
    const inspect = makeInspect({
      HostConfig: { ...(makeInspect().HostConfig as Record<string, unknown>), Privileged: true }
    });
    stubAgent(inspect);
    const world = await seedWorld();
    await seedInventoryRow(world.node1.id);
    const uniqueName = `Adopted Nginx Ack ${crypto.randomUUID().slice(0, 8)}`;

    const refused = await adoptContainer({
      nodeId: world.node1.id,
      dockerContainerId: "abc123def456",
      name: uniqueName,
      acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(refused.status).toBe("ack_required");

    // Without ack nothing was created.
    const count = await prisma.project.count({ where: { name: uniqueName } });
    expect(count).toBe(0);

    const preview = await previewContainerAdoption(world.node1.id, "abc123def456");
    const ackFingerprints = (preview?.highRiskFindings ?? []).map((f) => f.fingerprint ?? "");
    const accepted = await adoptContainer({
      nodeId: world.node1.id,
      dockerContainerId: "abc123def456",
      name: uniqueName,
      acknowledgedFindings: ackFingerprints,
      actor: sessionFor(world.adminA)
    });
    expect(accepted.status).toBe("adopted");
  });

  it("refuses adoption of a container already managed by another workload", async () => {
    stubAgent(makeInspect());
    const world = await seedWorld();
    const result = await adoptContainer({
      nodeId: world.node1.id,
      dockerContainerId: world.web.dockerContainerId,
      acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(result.status).toBe("already_managed");
  });

  it("client roles cannot adopt (workload.adopt is ADMIN-only)", async () => {
    const world = await seedWorld();
    // Direct route guard test: policy check via capabilitiesForRole.
    const { capabilitiesForRole } = await import("@/server/auth/policy");
    for (const role of [Role.CLIENT_ADMIN, Role.CLIENT_OPERATOR, Role.CLIENT_VIEWER]) {
      expect(capabilitiesForRole(role)).not.toContain("workload.adopt");
    }
  });
});
