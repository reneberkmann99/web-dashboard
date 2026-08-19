import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";
import { reconcileComposeWorkloads } from "@/server/services/compose";
import { ProjectSource } from "@prisma/client";

let world: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  resetDatabase();
  world = await seedWorld();
});

async function createComposeProject(composeProject: string, suffix: string) {
  return prisma.project.create({
    data: {
      name: `Compose ${suffix}`,
      slug: `compose-${suffix}`,
      clientAccountId: world.clientA.id,
      nodeId: world.node1.id,
      source: ProjectSource.COMPOSE,
      composeProject,
      isActive: true
    }
  });
}

function ref(overrides: Partial<{ id: string; name: string; composeProject: string; composeService: string }> = {}) {
  return {
    id: overrides.id ?? `c-${crypto.randomUUID()}`,
    name: overrides.name ?? "svc",
    image: "nginx:latest",
    composeProject: overrides.composeProject ?? "web",
    composeService: overrides.composeService ?? "web"
  };
}

describe("Compose workload reconciliation", () => {
  it("re-associates a recreated container (new Docker id) to the Compose workload", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const project = await createComposeProject(`web-${suffix}`, suffix);

    await prisma.container.create({
      data: {
        nodeId: world.node1.id,
        dockerContainerId: "olddockerid0001",
        dockerName: "web",
        image: "nginx:latest",
        composeProject: `web-${suffix}`,
        composeService: "web",
        projectId: project.id,
        isActive: true
      }
    });

    await reconcileComposeWorkloads(world.node1.id, [
      ref({ id: "newdockerid0001", name: "web", composeProject: `web-${suffix}`, composeService: "web" })
    ]);

    const fresh = await prisma.container.findUnique({
      where: { nodeId_dockerContainerId: { nodeId: world.node1.id, dockerContainerId: "newdockerid0001" } }
    });
    const stale = await prisma.container.findUnique({
      where: { nodeId_dockerContainerId: { nodeId: world.node1.id, dockerContainerId: "olddockerid0001" } }
    });

    expect(fresh?.projectId).toBe(project.id);
    expect(fresh?.isActive).toBe(true);
    expect(stale?.isActive).toBe(false);
  });

  it("adds a newly created Compose service to the workload", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const project = await createComposeProject(`web-${suffix}`, suffix);

    await prisma.container.create({
      data: {
        nodeId: world.node1.id,
        dockerContainerId: "webservice0001",
        dockerName: "web",
        image: "nginx:latest",
        composeProject: `web-${suffix}`,
        composeService: "web",
        projectId: project.id,
        isActive: true
      }
    });

    await reconcileComposeWorkloads(world.node1.id, [
      ref({ id: "webservice0001", name: "web", composeProject: `web-${suffix}`, composeService: "web" }),
      ref({ id: "dbservice00001", name: "db", composeProject: `web-${suffix}`, composeService: "db" })
    ]);

    const db = await prisma.container.findUnique({
      where: { nodeId_dockerContainerId: { nodeId: world.node1.id, dockerContainerId: "dbservice00001" } }
    });
    expect(db?.projectId).toBe(project.id);
    expect(db?.isActive).toBe(true);
  });

  it("marks a removed Compose service inactive", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const project = await createComposeProject(`web-${suffix}`, suffix);

    const ids = ["a-removed-00001", "b-kept-0000001"];
    for (const id of ids) {
      await prisma.container.create({
        data: {
          nodeId: world.node1.id,
          dockerContainerId: id,
          dockerName: id,
          image: "nginx:latest",
          composeProject: `web-${suffix}`,
          composeService: id,
          projectId: project.id,
          isActive: true
        }
      });
    }

    await reconcileComposeWorkloads(world.node1.id, [
      ref({ id: ids[1], name: ids[1], composeProject: `web-${suffix}`, composeService: ids[1] })
    ]);

    const removed = await prisma.container.findUnique({
      where: { nodeId_dockerContainerId: { nodeId: world.node1.id, dockerContainerId: ids[0] } }
    });
    const kept = await prisma.container.findUnique({
      where: { nodeId_dockerContainerId: { nodeId: world.node1.id, dockerContainerId: ids[1] } }
    });
    expect(removed?.isActive).toBe(false);
    expect(kept?.isActive).toBe(true);
    expect(kept?.projectId).toBe(project.id);
  });

  it("leaves manual workloads unchanged", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const manual = await prisma.project.create({
      data: {
        name: `Manual ${suffix}`,
        slug: `manual-${suffix}`,
        clientAccountId: world.clientA.id,
        nodeId: world.node1.id,
        source: ProjectSource.MANUAL,
        isActive: true
      }
    });
    const c = await prisma.container.create({
      data: {
        nodeId: world.node1.id,
        dockerContainerId: `manual-c-${suffix}`,
        dockerName: "manual-container",
        image: "busybox",
        projectId: manual.id,
        isActive: true
      }
    });

    // Reconcile with a totally unrelated compose inventory.
    await reconcileComposeWorkloads(world.node1.id, [
      ref({ id: "compose-other-1", composeProject: `other-${suffix}`, composeService: "x" })
    ]);

    const after = await prisma.container.findUnique({ where: { id: c.id } });
    expect(after?.projectId).toBe(manual.id);
    expect(after?.isActive).toBe(true);
  });

  it("survives container recreation without disturbing the tenant grant", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const project = await createComposeProject(`web-${suffix}`, suffix);

    const grant = await prisma.accessGrant.create({
      data: {
        clientAccountId: world.clientA.id,
        nodeId: world.node1.id,
        projectId: project.id,
        allowedActions: ["start", "stop", "restart", "view_logs"],
        isActive: true
      }
    });

    await reconcileComposeWorkloads(world.node1.id, [
      ref({ id: "recreated00001", name: "web", composeProject: `web-${suffix}`, composeService: "web" })
    ]);

    const fresh = await prisma.container.findUnique({
      where: { nodeId_dockerContainerId: { nodeId: world.node1.id, dockerContainerId: "recreated00001" } }
    });
    const g = await prisma.accessGrant.findUnique({ where: { id: grant.id } });
    expect(fresh?.projectId).toBe(project.id);
    expect(g?.isActive).toBe(true);
    expect(g?.projectId).toBe(project.id);
  });
});
