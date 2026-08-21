/**
 * E2E helpers — disposable-instance workflows.
 *
 * These specs run against a SCRATCH control plane (http://localhost:3200)
 * with its own Postgres, its own CA, and its own agent speaking to the REAL
 * local docker daemon. They NEVER point at the production 1337 instance and
 * never touch production docker objects: every fixture is created with a
 * unique name and removed by exact name/ID afterwards.
 */
import { expect, type BrowserContext, type Page } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/** Load the scratch-instance env (DATABASE_URL, keys, agent key, ports). */
function loadE2eEnv(): void {
  const file = "/tmp/noderaft-e2e/env.sh";
  if (!fs.existsSync(file)) throw new Error(`${file} missing — E2E instance not provisioned`);
  for (const m of fs.readFileSync(file, "utf8").matchAll(/^export (\w+)="?([^"\n]*)"?$/gm)) {
    process.env[m[1]] = m[2];
  }
}
loadE2eEnv();

export const BASE_URL = process.env.HOSTPANEL_URL ?? "http://localhost:3200";
export const prisma = new PrismaClient();
export const NODE_NAME = process.env.SEED_AGENT_NAME ?? "e2e-node";

export function suffix(): string {
  return crypto.randomBytes(4).toString("hex");
}

// ---------------------------------------------------------------------------
// Sessions — injected directly via DB (same pattern as phase6d specs).
// ---------------------------------------------------------------------------

export async function injectSession(context: BrowserContext, userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("hex");
  await prisma.session.create({
    data: {
      userId,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000)
    }
  });
  await context.addCookies([
    { name: "hostpanel_session", value: token, url: BASE_URL, httpOnly: true, sameSite: "Lax" },
    { name: "hostpanel_csrf", value: csrf, url: BASE_URL, httpOnly: false, sameSite: "Lax" }
  ]);
  return csrf;
}

export async function adminUserId(): Promise<string> {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
  if (!admin) throw new Error("No active admin in scratch DB");
  return admin.id;
}

export async function e2eNodeId(): Promise<string> {
  const node = await prisma.node.findFirst({ where: { name: NODE_NAME }, select: { id: true } });
  if (!node) throw new Error(`Node ${NODE_NAME} missing in scratch DB`);
  return node.id;
}

export async function newAdminContext(): Promise<{ context: BrowserContext; csrf: string }> {
  const { chromium } = await import("@playwright/test");
  const context = await chromium.launch().then((b) => b.newContext());
  const csrf = await injectSession(context, await adminUserId());
  return { context, csrf };
}

// ---------------------------------------------------------------------------
// API calls via the browser context (shares cookies, sends CSRF header).
// ---------------------------------------------------------------------------

export async function api<T = unknown>(
  page: Page,
  path: string,
  opts: { method?: string; body?: unknown; csrf: string; expectStatus?: number }
): Promise<T> {
  const res = await page.request.fetch(`${BASE_URL}${path}`, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json", "x-csrf-token": opts.csrf },
    data: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (opts.expectStatus !== undefined && res.status() !== opts.expectStatus) {
    throw new Error(`api ${opts.method ?? "GET"} ${path} -> ${res.status()} expected ${opts.expectStatus}: ${text.slice(0, 300)}`);
  }
  // Unwrap the standard { ok, data } envelope.
  if (json && typeof json === "object" && (json as { ok?: boolean }).ok === true && "data" in (json as object)) {
    return (json as { data: T }).data;
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// Docker helpers — fixtures only, by exact name/ID.
// ---------------------------------------------------------------------------

export function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

export function dockerInspect(nameOrId: string): Record<string, unknown> {
  return JSON.parse(docker(["inspect", nameOrId]))[0] as Record<string, unknown>;
}

export function containerState(nameOrId: string): { running: boolean; startedAt: string; id: string } {
  const raw = docker(["inspect", "--format", "{{.State.Running}}|{{.State.StartedAt}}|{{.Id}}", nameOrId]);
  const [running, startedAt, id] = raw.split("|");
  return { running: running === "true", startedAt, id };
}

export function containerNames(): string[] {
  return docker(["ps", "-a", "--format", "{{.Names}}"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function networkNames(): string[] {
  return docker(["network", "ls", "--format", "{{.Name}}"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function volumeNames(): string[] {
  return docker(["volume", "ls", "--format", "{{.Name}}"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type Inventory = { containers: string[]; networks: string[]; volumes: string[] };

export function snapshotInventory(): Inventory {
  return { containers: containerNames(), networks: networkNames(), volumes: volumeNames() };
}

/** Assert that everything NOT in fixtureNames is unchanged between inventories. */
export function assertUnrelatedUntouched(before: Inventory, after: Inventory, fixtureNames: string[]): void {
  const f = new Set(fixtureNames);
  expect(after.containers.filter((n) => !f.has(n)).sort()).toEqual(before.containers.filter((n) => !f.has(n)).sort());
  expect(after.networks.filter((n) => !f.has(n)).sort()).toEqual(before.networks.filter((n) => !f.has(n)).sort());
  expect(after.volumes.filter((n) => !f.has(n)).sort()).toEqual(before.volumes.filter((n) => !f.has(n)).sort());
}

// ---------------------------------------------------------------------------
// Deployment pipeline via API (fast, deterministic).
// ---------------------------------------------------------------------------

export type DeployedWorkload = {
  projectId: string;
  deploymentId: string;
  revisionId: string;
  composeProject: string;
};

/** Create a deployment definition via the admin API. */
export async function createDeploymentViaApi(
  page: Page,
  csrf: string,
  input: { name: string; nodeId: string; composeProject: string; compose: string; clientAccountId?: string | null }
): Promise<DeployedWorkload> {
  const res = await api<{ id: string; projectId: string; revisionId: string }>(
    page,
    "/api/admin/deployments",
    {
      method: "POST",
      csrf,
      expectStatus: 201,
      body: {
        nodeId: input.nodeId,
        name: input.name,
        composeProjectName: input.composeProject,
        compose: input.compose,
        environment: {},
        secretReferences: [],
        acknowledgedFindings: [],
        clientAccountId: input.clientAccountId ?? null
      }
    }
  );
  return { projectId: res.projectId, deploymentId: res.id, revisionId: res.revisionId, composeProject: input.composeProject };
}

/** Plan + deploy revision 1 and wait for the operation to reach a terminal state. */
export async function deployViaApi(
  page: Page,
  csrf: string,
  wl: DeployedWorkload,
  opts: { timeoutMs?: number } = {}
): Promise<{ operationId: string; succeeded: boolean }> {
  const plan = await api<{ planHash: string }>(page, `/api/admin/deployments/${wl.deploymentId}/plan`, {
    method: "POST",
    csrf,
    body: { revisionId: wl.revisionId }
  });
  const op = await api<{ operationId: string }>(page, `/api/admin/deployments/${wl.deploymentId}/deploy`, {
    method: "POST",
    csrf,
    body: { revisionId: wl.revisionId, planHash: plan.planHash }
  });
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  let last: { state: string } | null = null;
  while (Date.now() < deadline) {
    last = await prisma.deploymentOperation.findUnique({ where: { id: op.operationId }, select: { state: true } });
    if (last && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(last.state)) {
      return { operationId: op.operationId, succeeded: last.state === "SUCCEEDED" };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`deploy op ${op.operationId} did not finish; last state ${last?.state}`);
}

/** Create a revision, plan, deploy — the edit pipeline used by several specs. */
export async function editAndDeployViaApi(
  page: Page,
  csrf: string,
  wl: DeployedWorkload,
  compose: string,
  note?: string
): Promise<{ revisionId: string; succeeded: boolean }> {
  const rev = await api<{ revisionId: string }>(page, `/api/admin/deployments/${wl.deploymentId}/revisions`, {
    method: "POST",
    csrf,
    expectStatus: 201,
    body: { compose, environment: {}, secretReferences: [], acknowledgedFindings: [], deployNote: note ?? "e2e edit" }
  });
  wl.revisionId = rev.revisionId;
  const plan = await api<{ planHash: string }>(page, `/api/admin/deployments/${wl.deploymentId}/plan`, {
    method: "POST",
    csrf,
    body: { revisionId: rev.revisionId }
  });
  const op = await api<{ operationId: string }>(page, `/api/admin/deployments/${wl.deploymentId}/deploy`, {
    method: "POST",
    csrf,
    body: { revisionId: rev.revisionId, planHash: plan.planHash }
  });
  const deadline = Date.now() + 180_000;
  let last: { state: string } | null = null;
  while (Date.now() < deadline) {
    last = await prisma.deploymentOperation.findUnique({ where: { id: op.operationId }, select: { state: true } });
    if (last && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(last.state)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { revisionId: rev.revisionId, succeeded: last?.state === "SUCCEEDED" };
}

export async function newAdminSession(): Promise<{ token: string; csrf: string }> {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
  if (!admin) throw new Error("No active admin in scratch DB");
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("hex");
  await prisma.session.create({
    data: {
      userId: admin.id,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000)
    }
  });
  return { token, csrf };
}

/** Plain-fetch admin API call (no browser) — for beforeAll/afterAll cleanup. */
export async function adminFetch<T = unknown>(
  token: string,
  csrf: string,
  path: string,
  opts: { method?: string; body?: unknown; expectStatus?: number } = {}
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrf,
      cookie: `hostpanel_session=${token}; hostpanel_csrf=${csrf}`
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (opts.expectStatus !== undefined && res.status !== opts.expectStatus) {
    throw new Error(`adminFetch ${opts.method ?? "GET"} ${path} -> ${res.status} expected ${opts.expectStatus}: ${text.slice(0, 300)}`);
  }
  // Unwrap the standard { ok, data } envelope.
  if (json && typeof json === "object" && (json as { ok?: boolean }).ok === true && "data" in (json as object)) {
    return (json as { data: T }).data;
  }
  return json as T;
}

/** Delete a workload via the deletion-plan API (containers removed, volumes/networks preserved).
 *  NOTE: the backend REFUSES managed workloads (deployment exists) — use
 *  forceCleanupWorkload for those. This works for unmanaged workloads only. */
export async function deleteWorkloadViaApi(page: Page, csrf: string, projectId: string): Promise<void> {
  const plan = await api<{ managed: boolean; namedVolumesPreserved: boolean; networksPreserved: boolean }>(
    page,
    `/api/admin/workloads/${projectId}/deletion-plan`,
    { csrf }
  );
  expect(plan.namedVolumesPreserved).toBe(true);
  expect(plan.networksPreserved).toBe(true);
  await api(page, `/api/admin/workloads/${projectId}`, { method: "DELETE", csrf, expectStatus: 200 });
}

/**
 * Force-remove a disposable E2E fixture: docker containers by EXACT name +
 * DB rows in FK order. Managed workloads (deployment exists) cannot be
 * deleted through the API by design (codified in workload-lifecycle tests),
 * so E2E fixtures are removed directly from the SCRATCH database — never
 * from any production store.
 */
export async function forceCleanupWorkload(projectId: string, containerNames: string[]): Promise<void> {
  for (const name of containerNames) {
    try {
      docker(["rm", "-f", name]);
    } catch {
      /* already gone */
    }
  }
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return;
  const deployment = await prisma.deployment.findUnique({ where: { projectId }, select: { id: true } });
  if (deployment) {
    // Raw SQL mirrors the psql delete order proven against the scratch DB
    // (Prisma client deleteMany left FK-referencing rows behind here).
    await prisma.$executeRawUnsafe(`DELETE FROM "DeploymentRelease" WHERE "deploymentId" = $1`, deployment.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "DeploymentOperation" WHERE "deploymentId" = $1`, deployment.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "DeploymentRevision" WHERE "deploymentId" = $1`, deployment.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "Deployment" WHERE "id" = $1`, deployment.id);
  }
  await prisma.$executeRawUnsafe(`DELETE FROM "Container" WHERE "projectId" = $1`, projectId);
  await prisma.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, projectId);
}
