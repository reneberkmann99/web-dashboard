import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { parse } from "yaml";
import { DeploymentSource, ProjectSource } from "@prisma/client";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { nodeAgentClient } from "@/server/services/node-agent/client";
import {
  previewServiceRemoval,
  removeServiceFromWorkload,
  WorkloadServiceError
} from "@/server/services/workload-service-lifecycle";
import { generateDeploymentPlan } from "@/server/services/deployment-plan";

beforeAll(async () => {
  resetDatabase();
});

/**
 * Managed SERVICE removal: definition edit → revision → plan → (confirm) → deploy.
 * Nothing in this path may call Docker directly. The tests assert:
 *   - the agent's mutating surfaces are NEVER invoked
 *   - named volumes are reported as retained
 *   - the resulting plan marks the service REMOVE_CANDIDATE (never a hard delete)
 */

const COMPOSE = `services:
  web:
    image: nginx:stable
    networks:
      - frontend
      - shared
    volumes:
      - web-data:/var/lib/data
    environment:
      DB_PASSWORD: \${DB_PASSWORD}
  api:
    image: node:22-alpine
    networks:
      - frontend
    volumes:
      - api-data:/data
    environment:
      API_TOKEN: \${API_TOKEN}
networks:
  frontend: null
  shared:
    external: true
volumes:
  web-data: null
  api-data: null
`;

function stubAgentValidation(): void {
  vi.spyOn(nodeAgentClient, "validateCompose").mockImplementation(async (_node, input) => ({
    nodeOnline: true,
    composeSupported: true,
    composeVersion: "v2.30.0",
    valid: true,
    errors: [],
    normalized: input.compose
  }));
}

async function seedManagedWorkload(nodeId: string, clientAccountId: string | null) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const project = await prisma.project.create({
    data: {
      name: `Stack ${suffix}`,
      slug: `stack-${suffix}`,
      source: ProjectSource.COMPOSE,
      composeProject: `stack-${suffix}`,
      clientAccountId,
      nodeId,
      isActive: true
    }
  });
  const deployment = await prisma.deployment.create({
    data: { projectId: project.id, source: DeploymentSource.HOSTPANEL, composeProjectName: `stack-${suffix}` }
  });
  const revision = await prisma.deploymentRevision.create({
    data: {
      deploymentId: deployment.id,
      revisionNumber: 1,
      source: DeploymentSource.HOSTPANEL,
      composeSource: COMPOSE,
      composeCanonical: COMPOSE,
      environmentSnapshot: {},
      secretReferences: ["DB_PASSWORD", "API_TOKEN"],
      contentSha256: crypto.randomUUID(),
      analyzerVersion: "1"
    }
  });
  // Runtime containers for both services.
  for (const svc of ["web", "api"]) {
    await prisma.container.create({
      data: {
        nodeId,
        dockerContainerId: `${svc}-${suffix}`,
        dockerName: `stack-${suffix}-${svc}-1`,
        image: svc === "web" ? "nginx:stable" : "node:22-alpine",
        composeProject: `stack-${suffix}`,
        composeService: svc,
        projectId: project.id,
        isActive: true
      }
    });
  }
  return { project, deployment, revision, suffix };
}

describe("managed service removal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("previews impact: containers removed, shared network retained, named volumes retained", async () => {
    const world = await seedWorld();
    const { deployment } = await seedManagedWorkload(world.node1.id, null);

    const impact = await previewServiceRemoval({
      deploymentId: deployment.id,
      serviceName: "api",
      session: sessionFor(world.adminA),
      scope: "ADMIN"
    });

    expect(impact.serviceName).toBe("api");
    expect(impact.containersRemoved.map((c) => c.dockerName)).toEqual([
      expect.stringContaining("-api-1")
    ]);
    // frontend is still used by web → retained; api declared no exclusive network.
    expect(impact.networksRetained).toContain("frontend");
    expect(impact.networksNoLongerUsed).toEqual([]);
    // Named volume is ALWAYS retained (data preserved).
    expect(impact.volumesRetained).toEqual(["api-data"]);
    expect(impact.secretsNoLongerReferenced).toEqual(["API_TOKEN"]);
    expect(impact.secretsRetained).toEqual([]);
    expect(impact.remainingServices).toEqual(["web"]);
    expect(impact.removesLastService).toBe(false);
  });

  it("preview is read-only: no Docker mutation of any kind", async () => {
    const world = await seedWorld();
    const { deployment } = await seedManagedWorkload(world.node1.id, null);

    const remove = vi.spyOn(nodeAgentClient, "removeContainer");
    const action = vi.spyOn(nodeAgentClient, "runAction");
    const apply = vi.spyOn(nodeAgentClient, "applyDeployment");

    await previewServiceRemoval({
      deploymentId: deployment.id,
      serviceName: "api",
      session: sessionFor(world.adminA),
      scope: "ADMIN"
    });

    expect(remove).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("removal authors a new revision without the service and NEVER calls docker rm", async () => {
    stubAgentValidation();
    const remove = vi.spyOn(nodeAgentClient, "removeContainer");
    const apply = vi.spyOn(nodeAgentClient, "applyDeployment");

    const world = await seedWorld();
    const { deployment } = await seedManagedWorkload(world.node1.id, null);

    const result = await removeServiceFromWorkload({
      deploymentId: deployment.id,
      serviceName: "api",
      session: sessionFor(world.adminA),
      scope: "ADMIN"
    });

    expect(result.status).toBe("revision_created");
    if (result.status !== "revision_created") return;
    expect(result.revisionNumber).toBe(2);

    const rev = await prisma.deploymentRevision.findUniqueOrThrow({ where: { id: result.revisionId } });
    const parsed = parse(rev.composeSource) as { services: Record<string, unknown>; volumes: Record<string, unknown> };
    expect(Object.keys(parsed.services)).toEqual(["web"]);
    // The remaining service is untouched.
    expect((parsed.services.web as { image: string }).image).toBe("nginx:stable");
    // Volume declarations are preserved — removing a service never drops data.
    expect(Object.keys(parsed.volumes).sort()).toEqual(["api-data", "web-data"]);

    expect(remove).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();

    // The runtime container row is untouched until a deploy happens.
    const stillThere = await prisma.container.findFirst({
      where: { projectId: deployment.projectId, composeService: "api", isActive: true }
    });
    expect(stillThere).not.toBeNull();
  });

  it("the resulting plan marks the removed service REMOVE_CANDIDATE, never a delete", async () => {
    stubAgentValidation();
    const world = await seedWorld();
    const { deployment, revision } = await seedManagedWorkload(world.node1.id, null);

    // Pretend revision 1 is the current release so the plan has a baseline.
    const release = await prisma.deploymentRelease.create({
      data: {
        deploymentId: deployment.id,
        revisionId: revision.id,
        operationId: crypto.randomUUID(),
        healthVerdict: "HEALTHY",
        appliedAt: new Date()
      }
    });
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { currentReleaseId: release.id, lastHealthyReleaseId: release.id }
    });

    const result = await removeServiceFromWorkload({
      deploymentId: deployment.id,
      serviceName: "api",
      session: sessionFor(world.adminA),
      scope: "ADMIN"
    });
    if (result.status !== "revision_created") throw new Error(result.status);

    const plan = await generateDeploymentPlan({ deploymentId: deployment.id, revisionId: result.revisionId });
    const api = plan?.services.find((s) => s.serviceName === "api");
    expect(api?.action).toBe("REMOVE_CANDIDATE");
    const web = plan?.services.find((s) => s.serviceName === "web");
    expect(web?.action).toBe("UNCHANGED");
    // Networks/volumes are never scheduled for removal.
    expect(plan?.summary.volumesRemoved).toBe(0);
    expect(plan?.summary.networksRemoved).toBe(0);
  });

  it("refuses to empty a workload by removing its last service", async () => {
    stubAgentValidation();
    const world = await seedWorld();
    const suffix = crypto.randomUUID().slice(0, 8);
    const project = await prisma.project.create({
      data: {
        name: `Solo ${suffix}`,
        slug: `solo-${suffix}`,
        source: ProjectSource.COMPOSE,
        composeProject: `solo-${suffix}`,
        nodeId: world.node1.id,
        isActive: true
      }
    });
    const deployment = await prisma.deployment.create({
      data: { projectId: project.id, source: DeploymentSource.HOSTPANEL, composeProjectName: `solo-${suffix}` }
    });
    const only = "services:\n  only:\n    image: busybox\n";
    await prisma.deploymentRevision.create({
      data: {
        deploymentId: deployment.id,
        revisionNumber: 1,
        source: DeploymentSource.HOSTPANEL,
        composeSource: only,
        composeCanonical: only,
        environmentSnapshot: {},
        secretReferences: [],
        contentSha256: crypto.randomUUID(),
        analyzerVersion: "1"
      }
    });

    await expect(
      removeServiceFromWorkload({
        deploymentId: deployment.id,
        serviceName: "only",
        session: sessionFor(world.adminA),
        scope: "ADMIN"
      })
    ).rejects.toThrow(WorkloadServiceError);
  });

  it("refuses an unknown service name", async () => {
    const world = await seedWorld();
    const { deployment } = await seedManagedWorkload(world.node1.id, null);
    await expect(
      previewServiceRemoval({
        deploymentId: deployment.id,
        serviceName: "ghost",
        session: sessionFor(world.adminA),
        scope: "ADMIN"
      })
    ).rejects.toThrow("SERVICE_NOT_FOUND");
  });

  it("cross-tenant: another client cannot preview or remove a service (NOT_FOUND, no leak)", async () => {
    const world = await seedWorld();
    const { deployment } = await seedManagedWorkload(world.node1.id, world.clientA.id);
    await expect(
      previewServiceRemoval({
        deploymentId: deployment.id,
        serviceName: "api",
        session: sessionFor(world.clientBOperator),
        scope: "CLIENT"
      })
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      removeServiceFromWorkload({
        deploymentId: deployment.id,
        serviceName: "api",
        session: sessionFor(world.clientBOperator),
        scope: "CLIENT"
      })
    ).rejects.toThrow("NOT_FOUND");
  });
});
