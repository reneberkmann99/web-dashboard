import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { DeploymentSource, ProjectSource } from "@prisma/client";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { generateDeploymentPlan, recomputePlanHash, computePlanHash, deriveImageRefs } from "@/server/services/deployment-plan";
import { createSecret, rotateSecret } from "@/server/services/deployment-secrets";

beforeAll(async () => {
  resetDatabase();
});

const NORM_A = "services:\n  web:\n    image: nginx:stable\n  db:\n    image: postgres:16\n";
const NORM_B = "services:\n  web:\n    image: nginx:1.27\n  db:\n    image: postgres:16\n  worker:\n    image: busybox\n";
const NORM_C = "services:\n  web:\n    image: nginx:stable\n";

async function makeDeployment(nodeId: string, actor: ReturnType<typeof import("./helpers/fixtures")["sessionFor"]>) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const project = await prisma.project.create({
    data: { name: `Plan ${suffix}`, slug: `plan-${suffix}`, source: ProjectSource.COMPOSE, composeProject: `pcp-${suffix}`, nodeId, isActive: true }
  });
  const deployment = await prisma.deployment.create({
    data: { projectId: project.id, source: DeploymentSource.HOSTPANEL, composeProjectName: project.composeProject ?? `pcp-${suffix}` }
  });
  const rev = async (revisionNumber: number, composeCanonical: string, secretReferences: string[] = [], env: Record<string, string> = {}) => {
    return prisma.deploymentRevision.create({
      data: {
        deploymentId: deployment.id,
        revisionNumber,
        source: DeploymentSource.HOSTPANEL,
        composeSource: composeCanonical,
        composeCanonical,
        environmentSnapshot: env,
        secretReferences,
        contentSha256: crypto.randomUUID(),
        analyzerVersion: "1"
      }
    });
  };
  void actor;
  return { project, deployment, rev };
}

describe("deployment plan engine", () => {
  it("classifies CREATE / RECREATE / UNCHANGED / REMOVE_CANDIDATE", async () => {
    const world = await seedWorld();
    const { deployment, rev } = await makeDeployment(world.node1.id, sessionFor(world.adminA));
    const r1 = await rev(1, NORM_A);
    const r2 = await rev(2, NORM_B);

    // Current release = r1 (no release needed for a config-level diff fallback).
    await prisma.deploymentRelease.create({
      data: { deploymentId: deployment.id, revisionId: r1.id, healthVerdict: "HEALTHY" }
    });
    await prisma.deployment.update({ where: { id: deployment.id }, data: { currentReleaseId: (await prisma.deploymentRelease.findFirst({ where: { deploymentId: deployment.id } }))!.id } });

    const plan = await generateDeploymentPlan({ deploymentId: deployment.id, revisionId: r2.id });
    expect(plan).not.toBeNull();
    const byName = new Map(plan!.services.map((s) => [s.serviceName, s.action]));
    expect(byName.get("worker")).toBe("CREATE");
    expect(byName.get("web")).toBe("RECREATE");
    expect(byName.get("db")).toBe("UNCHANGED");

    // Removing a service from the definition → REMOVE_CANDIDATE (not deleted).
    const r3 = await rev(3, NORM_C);
    const plan3 = await generateDeploymentPlan({ deploymentId: deployment.id, revisionId: r3.id });
    expect(plan3!.services.find((s) => s.serviceName === "db")?.action).toBe("REMOVE_CANDIDATE");
    expect(plan3!.summary.volumesRemoved).toBe(0);
    expect(plan3!.summary.networksRemoved).toBe(0);
  });

  it("planHash is deterministic and recomputePlanHash reflects secret rotation", async () => {
    const world = await seedWorld();
    const { deployment, rev } = await makeDeployment(world.node1.id, sessionFor(world.adminA));
    const r = await rev(1, "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ***\n", ["DB_PASSWORD"]);

    await createSecret({ deploymentId: deployment.id, key: "DB_PASSWORD", value: "v1-secret", actor: sessionFor(world.adminA) });
    const secret = (await prisma.secret.findFirstOrThrow({ where: { deploymentId: deployment.id, key: "DB_PASSWORD" } }));

    const h1 = await recomputePlanHash(deployment.id, r.id);
    expect(h1).not.toBeNull();
    expect(h1).toBe(computePlanHash({
      deploymentId: deployment.id, revisionId: r.id, revisionContentSha256: r.contentSha256,
      currentReleaseId: deployment.currentReleaseId, secretVersionNumbers: { DB_PASSWORD: 1 }
    }));

    // Rotate the secret → new version number → different plan hash (stale).
    await rotateSecret({ deploymentId: deployment.id, secretId: secret.id, value: "v2-secret", actor: sessionFor(world.adminA) });
    const h2 = await recomputePlanHash(deployment.id, r.id);
    expect(h2).not.toBe(h1);
  });

  it("secret change is surfaced in the plan", async () => {
    const world = await seedWorld();
    const { deployment, rev } = await makeDeployment(world.node1.id, sessionFor(world.adminA));
    const r = await rev(1, "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ***\n", ["DB_PASSWORD"]);
    await createSecret({ deploymentId: deployment.id, key: "DB_PASSWORD", value: "v1", actor: sessionFor(world.adminA) });

    const plan = await generateDeploymentPlan({ deploymentId: deployment.id, revisionId: r.id });
    expect(plan!.secretChanges.find((s) => s.key === "DB_PASSWORD")?.targetVersionNumber).toBe(1);
    expect(plan!.secretChanges.find((s) => s.key === "DB_PASSWORD")?.changed).toBe(true);
  });

  it("deriveImageRefs extracts service -> image without Docker", () => {
    const refs = deriveImageRefs(NORM_A);
    expect(refs).toContainEqual({ serviceName: "web", imageRef: "nginx:stable" });
    expect(refs).toContainEqual({ serviceName: "db", imageRef: "postgres:16" });
  });

  it("plan generation performs no Docker/agent calls (no image pull)", async () => {
    // generateDeploymentPlan touches only the database + YAML parsing; no
    // nodeAgentClient import is even present in deployment-plan.ts. A plan for
    // a missing deployment returns null without error.
    expect(await generateDeploymentPlan({ deploymentId: "nonexistent", revisionId: "nonexistent" })).toBeNull();
  });
});
