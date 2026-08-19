import crypto from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld } from "./helpers/fixtures";
import {
  adoptComposeProject,
  previewConvertToCompose,
  convertToComposeManaged,
  detachComposeTracking
} from "@/server/services/compose";
import { ProjectSource } from "@prisma/client";

let world: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  resetDatabase();
  world = await seedWorld();
});

function suffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function createComposeContainers(nodeId: string, composeProject: string, dockerIds: string[]) {
  const out = [];
  for (const id of dockerIds) {
    out.push(
      await prisma.container.create({
        data: {
          nodeId,
          dockerContainerId: id,
          dockerName: id,
          image: "nginx:latest",
          composeProject,
          composeService: id,
          isActive: true
        }
      })
    );
  }
  return out;
}

describe("Compose adoption", () => {
  it("adopts a discovered project with a client", async () => {
    const s = suffix();
    const containers = await createComposeContainers(world.node1.id, `stack-${s}`, [`c1-${s}`, `c2-${s}`]);

    const result = await adoptComposeProject({
      nodeId: world.node1.id,
      composeProject: `stack-${s}`,
      clientAccountId: world.clientA.id,
      name: `Friendly ${s}`
    });

    expect(result.status).toBe("adopted");
    if (result.status !== "adopted") return;
    const project = await prisma.project.findUnique({ where: { id: result.id } });
    expect(project?.source).toBe(ProjectSource.COMPOSE);
    expect(project?.composeProject).toBe(`stack-${s}`);
    expect(project?.clientAccountId).toBe(world.clientA.id);
    expect(project?.name).toBe(`Friendly ${s}`);

    // Containers now belong to the workload.
    const members = await prisma.container.findMany({ where: { projectId: result.id } });
    expect(members.map((m) => m.id).sort()).toEqual(containers.map((c) => c.id).sort());
  });

  it("adopts as an internal workload (no client)", async () => {
    const s = suffix();
    await createComposeContainers(world.node1.id, `stack-${s}`, [`c1-${s}`]);

    const result = await adoptComposeProject({
      nodeId: world.node1.id,
      composeProject: `stack-${s}`,
      clientAccountId: null
    });

    expect(result.status).toBe("adopted");
    if (result.status !== "adopted") return;
    const project = await prisma.project.findUnique({ where: { id: result.id } });
    expect(project?.clientAccountId).toBeNull();
  });

  it("cannot be adopted twice", async () => {
    const s = suffix();
    await createComposeContainers(world.node1.id, `stack-${s}`, [`c1-${s}`]);

    const first = await adoptComposeProject({ nodeId: world.node1.id, composeProject: `stack-${s}`, clientAccountId: null });
    expect(first.status).toBe("adopted");

    const second = await adoptComposeProject({ nodeId: world.node1.id, composeProject: `stack-${s}`, clientAccountId: null });
    expect(second.status).toBe("already_adopted");
  });

  it("keeps the same compose project on two nodes unambiguous", async () => {
    const s = suffix();
    await createComposeContainers(world.node1.id, `stack-${s}`, [`n1-${s}`]);
    await createComposeContainers(world.node2.id, `stack-${s}`, [`n2-${s}`]);

    const a = await adoptComposeProject({ nodeId: world.node1.id, composeProject: `stack-${s}`, clientAccountId: null });
    const b = await adoptComposeProject({ nodeId: world.node2.id, composeProject: `stack-${s}`, clientAccountId: null });
    expect(a.status).toBe("adopted");
    expect(b.status).toBe("adopted");
    if (a.status !== "adopted" || b.status !== "adopted") return;
    expect(a.id).not.toBe(b.id);
  });

  it("refuses to silently steal containers from an existing workload", async () => {
    const s = suffix();
    // A manual workload already owns container m1.
    const manual = await prisma.project.create({
      data: {
        name: `Manual ${s}`,
        slug: `manual-${s}`,
        clientAccountId: world.clientA.id,
        nodeId: world.node1.id,
        source: ProjectSource.MANUAL,
        isActive: true
      }
    });
    const m1 = await createComposeContainers(world.node1.id, `stack-${s}`, [`m1-${s}`]);
    await prisma.container.update({ where: { id: m1[0].id }, data: { projectId: manual.id } });
    await createComposeContainers(world.node1.id, `stack-${s}`, [`m2-${s}`]);

    const result = await adoptComposeProject({ nodeId: world.node1.id, composeProject: `stack-${s}`, clientAccountId: null });
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].workloadId).toBe(manual.id);
    expect(result.conflicts[0].containerNames).toEqual([`m1-${s}`]);

    // Container still belongs to the manual workload — nothing was stolen.
    const still = await prisma.container.findUnique({ where: { id: m1[0].id } });
    expect(still?.projectId).toBe(manual.id);
  });

  it("proceeds only with explicit moveConflictingContainers", async () => {
    const s = suffix();
    const manual = await prisma.project.create({
      data: {
        name: `Manual2 ${s}`,
        slug: `manual2-${s}`,
        clientAccountId: world.clientA.id,
        nodeId: world.node1.id,
        source: ProjectSource.MANUAL,
        isActive: true
      }
    });
    const m1 = await createComposeContainers(world.node1.id, `stack-${s}`, [`p1-${s}`]);
    await prisma.container.update({ where: { id: m1[0].id }, data: { projectId: manual.id } });

    const result = await adoptComposeProject({
      nodeId: world.node1.id,
      composeProject: `stack-${s}`,
      clientAccountId: world.clientB.id,
      moveConflictingContainers: true
    });
    expect(result.status).toBe("adopted");
    if (result.status !== "adopted") return;

    const moved = await prisma.container.findUnique({ where: { id: m1[0].id } });
    expect(moved?.projectId).toBe(result.id);
    expect(moved?.isActive).toBe(true);
  });
});

async function manualWithContainers(composeProjects: Array<string | null>, s: string) {
  const project = await prisma.project.create({
    data: {
      name: `Convert ${s}`,
      slug: `convert-${s}`,
      clientAccountId: world.clientA.id,
      nodeId: world.node1.id,
      source: ProjectSource.MANUAL,
      isActive: true
    }
  });
  const containers = [];
  for (let i = 0; i < composeProjects.length; i++) {
    const id = `conv-${s}-${i}`;
    containers.push(
      await prisma.container.create({
        data: {
          nodeId: world.node1.id,
          dockerContainerId: id,
          dockerName: id,
          image: "nginx:latest",
          composeProject: composeProjects[i],
          composeService: id,
          projectId: project.id,
          isActive: true
        }
      })
    );
  }
  return { project, containers };
}

describe("Manual → Compose conversion", () => {
  it("converts a safe matching workload in place, retaining id/grants", async () => {
    const s = suffix();
    const { project } = await manualWithContainers([`stack-${s}`, `stack-${s}`], s);

    // Grant before conversion.
    const grant = await prisma.accessGrant.create({
      data: {
        clientAccountId: world.clientA.id,
        nodeId: world.node1.id,
        projectId: project.id,
        allowedActions: ["start", "stop", "restart", "view_logs"],
        isActive: true
      }
    });

    const preview = await previewConvertToCompose(project.id);
    expect(preview?.eligible).toBe(true);
    if (!preview?.eligible) return;
    expect(preview.composeProject).toBe(`stack-${s}`);

    const converted = await convertToComposeManaged(project.id);
    expect("id" in converted).toBe(true);

    const after = await prisma.project.findUnique({ where: { id: project.id } });
    expect(after?.id).toBe(project.id); // retained
    expect(after?.source).toBe(ProjectSource.COMPOSE);
    expect(after?.composeProject).toBe(`stack-${s}`);
    expect(after?.clientAccountId).toBe(world.clientA.id); // retained

    // Grant survives and still resolves.
    const g = await prisma.accessGrant.findUnique({ where: { id: grant.id } });
    expect(g?.isActive).toBe(true);
    expect(g?.projectId).toBe(project.id);
  });

  it("cannot convert an ambiguous workload (multiple compose projects)", async () => {
    const s = suffix();
    const { project } = await manualWithContainers([`stack-a-${s}`, `stack-b-${s}`], s);

    const preview = await previewConvertToCompose(project.id);
    expect(preview?.eligible).toBe(false);
    if (!preview || preview.eligible) return;
    expect(preview.reason).toBe("multiple_compose_projects");

    const converted = await convertToComposeManaged(project.id);
    expect("error" in converted).toBe(true);
  });

  it("cannot convert when the compose project is already adopted elsewhere", async () => {
    const s = suffix();
    await prisma.project.create({
      data: {
        name: `Already ${s}`,
        slug: `already-${s}`,
        clientAccountId: world.clientB.id,
        nodeId: world.node1.id,
        source: ProjectSource.COMPOSE,
        composeProject: `stack-${s}`,
        isActive: true
      }
    });
    const { project } = await manualWithContainers([`stack-${s}`], s);

    const preview = await previewConvertToCompose(project.id);
    expect(preview?.eligible).toBe(false);
    if (!preview || preview.eligible) return;
    expect(preview.reason).toBe("compose_project_already_adopted_elsewhere");
  });

  it("cannot convert when membership is incomplete", async () => {
    const s = suffix();
    const { project } = await manualWithContainers([`stack-${s}`], s);
    // One more live container of the same compose project exists outside the workload.
    await createComposeContainers(world.node1.id, `stack-${s}`, [`extra-${s}`]);

    const preview = await previewConvertToCompose(project.id);
    expect(preview?.eligible).toBe(false);
    if (!preview || preview.eligible) return;
    expect(preview.reason).toBe("partial_membership");
  });
});

describe("Compose detach", () => {
  it("detaches to MANUAL without touching Docker resources or grants", async () => {
    const s = suffix();
    const containers = await createComposeContainers(world.node1.id, `stack-${s}`, [`d1-${s}`, `d2-${s}`]);
    const project = await prisma.project.create({
      data: {
        name: `Detach ${s}`,
        slug: `detach-${s}`,
        clientAccountId: world.clientA.id,
        nodeId: world.node1.id,
        source: ProjectSource.COMPOSE,
        composeProject: `stack-${s}`,
        isActive: true
      }
    });
    await prisma.container.updateMany({ where: { id: { in: containers.map((c) => c.id) } }, data: { projectId: project.id } });
    const grant = await prisma.accessGrant.create({
      data: {
        clientAccountId: world.clientA.id,
        nodeId: world.node1.id,
        projectId: project.id,
        allowedActions: ["start", "stop", "restart", "view_logs"],
        isActive: true
      }
    });

    const result = await detachComposeTracking(project.id);
    expect(result?.id).toBe(project.id);

    const after = await prisma.project.findUnique({ where: { id: project.id } });
    expect(after?.source).toBe(ProjectSource.MANUAL);
    expect(after?.composeProject).toBeNull();

    // Containers untouched — still members, still active.
    const members = await prisma.container.findMany({ where: { projectId: project.id, isActive: true } });
    expect(members.map((m) => m.id).sort()).toEqual(containers.map((c) => c.id).sort());

    // Grant remains valid.
    const g = await prisma.accessGrant.findUnique({ where: { id: grant.id } });
    expect(g?.isActive).toBe(true);
    expect(g?.projectId).toBe(project.id);
  });

  it("refuses to detach a non-COMPOSE workload", async () => {
    const s = suffix();
    const { project } = await manualWithContainers([null], s);
    expect(await detachComposeTracking(project.id)).toBeNull();
  });
});
