import crypto from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectSource } from "@prisma/client";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import {
  mergeSynthesizedServices,
  createComposeAdoptionDefinition
} from "@/server/services/compose-adoption-definition";

let world: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  resetDatabase();
  world = await seedWorld();
});

function suffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Same proven fixture shape as the container-adoption tests. */
function makeInspect(overrides: Record<string, unknown> = {}) {
  return {
    Id: "abc123def456abc123def456abc123def456abc123def456abc123def456ab12",
    Name: "/stack-container",
    Created: "2026-08-01T10:00:00Z",
    State: { Running: true, StartedAt: "2026-08-01T10:00:01Z", Status: "running" },
    Config: {
      Hostname: "abc123def456",
      User: "",
      Env: ["LOG_LEVEL=info", "PORT=8080"],
      Cmd: ["nginx", "-g", "daemon off;"],
      Image: "nginx:1.27-alpine",
      WorkingDir: "",
      Entrypoint: [],
      Labels: {},
      ExposedPorts: { "80/tcp": {} },
      Healthcheck: null
    },
    HostConfig: {
      Binds: null,
      PortBindings: {
        "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }]
      },
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Memory: 0,
      NanoCpus: 0,
      Privileged: false,
      ReadonlyRootfs: false,
      CapAdd: null,
      CapDrop: null,
      Dns: null,
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
      { Type: "volume", Source: "/var/lib/docker/volumes/stack-data/_data", Destination: "/data", Mode: "", RW: true, Name: "stack-data" }
    ],
    NetworkSettings: {
      Networks: {
        "stack_default": { Aliases: ["stack-container"], IPAddress: "172.18.0.2", Gateway: "172.18.0.1", NetworkID: "net1" }
      }
    },
    ...overrides
  } as Record<string, unknown>;
}

/** Mirror adoptComposeProject's outcome: a COMPOSE project + linked containers. */
async function seedAdoptedProject(composeProject: string, services: Array<{ id: string; name: string; image: string }>) {
  const project = await prisma.project.create({
    data: {
      name: composeProject,
      slug: composeProject,
      source: ProjectSource.COMPOSE,
      composeProject,
      clientAccountId: world.clientA.id,
      nodeId: world.node1.id,
      isActive: true
    }
  });
  for (const svc of services) {
    await prisma.container.create({
      data: {
        nodeId: world.node1.id,
        dockerContainerId: svc.id,
        dockerName: `${composeProject}-${svc.name}-1`,
        image: svc.image,
        composeProject,
        composeService: svc.name,
        projectId: project.id,
        lastKnownStatus: "running",
        isActive: true
      }
    });
  }
  return project;
}

function stubAgent(): void {
  vi.spyOn(nodeAgentClient, "inspectContainerFull").mockImplementation(async (_node, id) => {
    const which = String(id);
    const image = which.startsWith("c1-") ? "nginx:1.27-alpine" : "busybox:1.36";
    const base = makeInspect();
    const cfg = { ...(base.Config as Record<string, unknown>), Image: image };
    return { nodeOnline: true, inspect: { ...base, Config: cfg } };
  });
  vi.spyOn(nodeAgentClient, "validateCompose").mockImplementation(async (_node, input) => ({
    nodeOnline: true,
    composeSupported: true,
    composeVersion: "v2.30.0",
    valid: true,
    errors: [],
    normalized: input.compose
  }));
  // Adoption must never create/remove/restart anything on docker.
  vi.spyOn(nodeAgentClient, "removeContainer").mockImplementation(async () => {
    throw new Error("removeContainer must not be called during adoption");
  });
  vi.spyOn(nodeAgentClient, "runAction").mockImplementation(async () => {
    throw new Error("runAction must not be called during adoption");
  });
}

describe("mergeSynthesizedServices", () => {
  it("merges two services and dedupes shared networks/volumes", () => {
    const web = `services:
  app:
    image: nginx:stable
    ports:
      - "8080:80"
networks:
  front:
    external: true
volumes:
  data:
    external: true
`;
    const worker = `services:
  app:
    image: busybox:latest
    command: ["sleep", "3600"]
networks:
  front:
    external: true
  back:
    external: true
volumes:
  data:
    external: true
  cache:
    external: true
`;
    const merged = mergeSynthesizedServices([
      { serviceName: "web", compose: web },
      { serviceName: "worker", compose: worker }
    ]);

    expect(merged.serviceNames).toEqual(["web", "worker"]);
    expect(merged.networks).toEqual(["front", "back"]);
    expect(merged.volumes).toEqual(["data", "cache"]);
    expect(merged.compose).toContain("web:");
    expect(merged.compose).toContain("worker:");
    expect(merged.compose).toContain("nginx:stable");
    expect(merged.compose).toContain("busybox:latest");
  });

  it("skips invalid entries and duplicate service names", () => {
    const merged = mergeSynthesizedServices([
      { serviceName: "web", compose: "services:\n  app:\n    image: nginx:stable\n" },
      { serviceName: "web", compose: "services:\n  app:\n    image: httpd:alpine\n" },
      { serviceName: "", compose: "services:\n  app:\n    image: busybox:latest\n" },
      { serviceName: "broken", compose: "not: [valid yaml" }
    ]);
    expect(merged.serviceNames).toEqual(["web"]);
    expect(merged.compose).toContain("nginx:stable");
    expect(merged.compose).not.toContain("httpd");
  });
});

describe("createComposeAdoptionDefinition", () => {
  it("authors a managed definition onto the adopted project without any docker mutation", async () => {
    const s = suffix();
    const project = `stack-${s}`;
    const adopted = await seedAdoptedProject(project, [
      { id: `c1-${s}`, name: "web", image: "nginx:1.27-alpine" },
      { id: `c2-${s}`, name: "worker", image: "busybox:1.36" }
    ]);

    stubAgent();
    const removeSpy = vi.spyOn(nodeAgentClient, "removeContainer");
    const runActionSpy = vi.spyOn(nodeAgentClient, "runAction");
    const inspectSpy = vi.spyOn(nodeAgentClient, "inspectContainerFull");

    const result = await createComposeAdoptionDefinition({
      nodeId: world.node1.id,
      projectId: adopted.id,
      composeProject: project,
      name: `Friendly ${s}`,
      clientAccountId: world.clientA.id,
      acknowledgedFindings: [],
      actor: sessionFor(world.adminA),
      sourceIp: "10.0.0.1"
    });

    // No docker mutation at adoption time.
    expect(removeSpy).not.toHaveBeenCalled();
    expect(runActionSpy).not.toHaveBeenCalled();

    if (result.status !== "definition_created") {
      throw new Error(`expected definition_created, got ${JSON.stringify(result)}`);
    }

    // The definition was authored ONTO the adopted project (same row).
    expect(result.projectId).toBe(adopted.id);
    const projectRow = await prisma.project.findUniqueOrThrow({ where: { id: adopted.id } });
    expect(projectRow.name).toBe(`Friendly ${s}`);
    expect(projectRow.clientAccountId).toBe(world.clientA.id);

    const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: result.deploymentId } });
    expect(deployment.projectId).toBe(adopted.id);
    expect(deployment.runtimeState).toBe("CONVERGED");
    expect(deployment.composeProjectName).toBe(project);

    const revision = await prisma.deploymentRevision.findFirstOrThrow({
      where: { deploymentId: result.deploymentId },
      orderBy: { revisionNumber: "desc" }
    });
    expect(revision.revisionNumber).toBe(1);
    expect(revision.composeSource).toContain("web:");
    expect(revision.composeSource).toContain("worker:");
    expect(revision.composeSource).toContain("nginx:1.27-alpine");
    expect(revision.composeSource).toContain("busybox:1.36");
    expect(revision.composeSource).toContain("stack-data");
    expect(revision.composeSource).toContain("stack_default");
    expect(revision.deployNote).toContain("without recreation");

    expect(inspectSpy).toHaveBeenCalledTimes(2);

    // The form editor can open this definition: parse back into structured form.
    const { parseComposeToForm } = await import("@/lib/compose-form/parse");
    const parsed = parseComposeToForm(revision.composeSource, []);
    expect(parsed.parseError).toBeNull();
    expect(parsed.services.map((sv) => sv.name)).toEqual(["web", "worker"]);
    expect(parsed.networks[0].name).toBe("stack_default");
    expect(parsed.volumes[0].name).toBe("stack-data");
  });

  it("requires acknowledgement for high-risk findings and refuses otherwise", async () => {
    const s = suffix();
    const project = `priv-${s}`;
    const adopted = await seedAdoptedProject(project, [{ id: `p1-${s}`, name: "app", image: "nginx:1.27-alpine" }]);

    vi.spyOn(nodeAgentClient, "inspectContainerFull").mockImplementation(async () => ({
      nodeOnline: true,
      inspect: makeInspect({ HostConfig: { ...(makeInspect().HostConfig as Record<string, unknown>), Privileged: true } })
    }));
    const validateSpy = vi
      .spyOn(nodeAgentClient, "validateCompose")
      .mockImplementation(async (_node, input) => ({
        nodeOnline: true,
        composeSupported: true,
        composeVersion: "v2.30.0",
        valid: true,
        errors: [],
        normalized: input.compose
      }));

    const refused = await createComposeAdoptionDefinition({
      nodeId: world.node1.id,
      projectId: adopted.id,
      composeProject: project,
      name: `Priv ${s}`,
      acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(refused.status).toBe("ack_required");
    expect(validateSpy).not.toHaveBeenCalled();

    const accepted = await createComposeAdoptionDefinition({
      nodeId: world.node1.id,
      projectId: adopted.id,
      composeProject: project,
      name: `Priv ${s}`,
      acknowledgedFindings: (refused.status === "ack_required" ? refused.highRiskFindings : [])
        .map((f) => f.fingerprint ?? "")
        .filter(Boolean),
      actor: sessionFor(world.adminA)
    });
    expect(accepted.status).toBe("definition_created");
  });
});
