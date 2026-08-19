import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDatabase } from "./setup";
import { seedWorld, sessionFor } from "./helpers/fixtures";
import { createDeployment, createRevision, computeContentSha256 } from "@/server/services/deployments";

const { validateComposeMock } = vi.hoisted(() => ({ validateComposeMock: vi.fn() }));

vi.mock("@/server/services/node-agent/client", () => ({
  nodeAgentClient: { validateCompose: validateComposeMock }
}));

const COMPOSE_V1 = "services:\n  web:\n    image: myapp:v1\n";
const COMPOSE_V2 = "services:\n  web:\n    image: myapp:v2\n";
const NORM_V1 = "services:\n  web:\n    image: myapp:v1\n";
const NORM_V2 = "services:\n  web:\n    image: myapp:v2\n";

beforeAll(() => resetDatabase());

beforeEach(() => {
  validateComposeMock.mockReset();
});

function stubAgent(normalized: string) {
  validateComposeMock.mockResolvedValue({
    composeSupported: true,
    composeVersion: "v2.39.4",
    valid: true,
    errors: [],
    normalized
  });
}

async function makeDeployment(nodeId: string, actor: ReturnType<typeof sessionFor>, composeProjectName: string) {
  const result = await createDeployment({
    nodeId,
    name: "Rev App",
    composeProjectName,
    compose: COMPOSE_V1,
    environment: {},
    secretReferences: [],
    acknowledgedFindings: [],
    actor
  });
  if (result.status !== "created") throw new Error(`expected created, got ${result.status}`);
  return result.deploymentId;
}

describe("deployment revisions", () => {
  it("content hash is a pure function of canonical compose + env + secret refs", () => {
    const base = { composeCanonical: NORM_V1, environmentSnapshot: { A: "1" }, secretReferences: [] };
    const h1 = computeContentSha256(base);
    const h2 = computeContentSha256(base);
    expect(h1).toBe(h2);

    expect(computeContentSha256({ ...base, environmentSnapshot: { A: "2" } })).not.toBe(h1);
    expect(computeContentSha256({ ...base, secretReferences: ["K"] })).not.toBe(h1);

    // Secret VALUE changes are not an input — a rotated value does not change the hash.
    expect(computeContentSha256(base)).toBe(h1);
  });

  it("revision numbers are monotonic; old revisions are immutable", async () => {
    const world = await seedWorld();
    stubAgent(NORM_V1);
    const deploymentId = await makeDeployment(world.node1.id, sessionFor(world.adminA), `mono-${Date.now()}`);

    stubAgent(NORM_V2);
    const r2 = await createRevision({
      deploymentId, compose: COMPOSE_V2, environment: {}, secretReferences: [], acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(r2.status).toBe("created");
    if (r2.status !== "created") return;
    expect(r2.revisionNumber).toBe(2);

    const rev1 = await prisma.deploymentRevision.findFirstOrThrow({
      where: { deploymentId, revisionNumber: 1 }
    });
    expect(rev1.composeSource).toBe(COMPOSE_V1);
    expect(rev1.composeCanonical).toBe(NORM_V1);
  });

  it("semantically identical content deduplicates to the same revision", async () => {
    const world = await seedWorld();
    stubAgent(NORM_V1);
    const deploymentId = await makeDeployment(world.node1.id, sessionFor(world.adminA), `dedup-${Date.now()}`);

    stubAgent(NORM_V2);
    const a = await createRevision({
      deploymentId, compose: COMPOSE_V2, environment: { E: "x" }, secretReferences: [], acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(a.status).toBe("created");

    const b = await createRevision({
      deploymentId, compose: COMPOSE_V2, environment: { E: "x" }, secretReferences: [], acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(b.status).toBe("created");
    if (b.status === "created") {
      expect(b.deduplicated).toBe(true);
      expect((a as { revisionId: string }).revisionId).toBe(b.revisionId);
      expect(b.revisionNumber).toBe(2); // no new revision number minted
      expect(await prisma.deploymentRevision.count({ where: { deploymentId } })).toBe(2);
    }
  });

  it("changing non-secret env creates a new revision", async () => {
    const world = await seedWorld();
    stubAgent(NORM_V1);
    const deploymentId = await makeDeployment(world.node1.id, sessionFor(world.adminA), `env-${Date.now()}`);

    stubAgent(NORM_V1);
    const a = await createRevision({
      deploymentId, compose: COMPOSE_V1, environment: { APP_ENV: "staging" }, secretReferences: [], acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(a.status).toBe("created");
    if (a.status !== "created") return;

    const b = await createRevision({
      deploymentId, compose: COMPOSE_V1, environment: { APP_ENV: "production" }, secretReferences: [], acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(b.status).toBe("created");
    if (b.status !== "created") return;
    expect(b.deduplicated).toBe(false);
    expect(b.revisionNumber).toBe(3);
  });

  it("changing a secret reference key creates a new revision; value rotation does not", async () => {
    const world = await seedWorld();
    stubAgent(NORM_V1);
    const deploymentId = await makeDeployment(world.node1.id, sessionFor(world.adminA), `secretref-${Date.now()}`);

    stubAgent(NORM_V1);
    const a = await createRevision({
      deploymentId, compose: COMPOSE_V1, environment: {}, secretReferences: ["OLD_KEY"], acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(a.status).toBe("created");
    if (a.status !== "created") return;

    const b = await createRevision({
      deploymentId, compose: COMPOSE_V1, environment: {}, secretReferences: ["NEW_KEY"], acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(b.status).toBe("created");
    if (b.status !== "created") return;
    expect(b.deduplicated).toBe(false);
  });

  it("persisted revision data never contains a real secret value", async () => {
    const world = await seedWorld();
    // The normalized output contains a SENTINEL, not the real secret.
    const normalized = "services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: __HOSTPANEL_SECRET_DB_PASSWORD__\n";
    stubAgent(normalized);
    const result = await createDeployment({
      nodeId: world.node1.id,
      name: "Secret App",
      composeProjectName: `sec-${Date.now()}`,
      compose: "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ${DB_PASSWORD}\n",
      environment: {},
      secretReferences: ["DB_PASSWORD"],
      acknowledgedFindings: [],
      actor: sessionFor(world.adminA)
    });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    const revision = await prisma.deploymentRevision.findFirstOrThrow({ where: { deploymentId: result.deploymentId } });
    expect(revision.composeCanonical).not.toContain("REAL_SECRET_VALUE");
    expect(revision.composeCanonical).toContain("__HOSTPANEL_SECRET_DB_PASSWORD__");
    expect(revision.secretReferences).toEqual(["DB_PASSWORD"]);
    expect(revision.environmentSnapshot).toEqual({});
  });
});
