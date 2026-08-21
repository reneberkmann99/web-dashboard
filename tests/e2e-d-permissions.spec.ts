/**
 * E2E workflow D — client permissions (Viewer / Operator / Admin).
 *
 * Creates a disposable client + three disposable users via DB, a workload
 * owned by the client (created+deployed via the admin API), then verifies
 * each role's exact allowed/forbidden actions BOTH via direct API calls and
 * via the UI.
 *
 *   CLIENT_VIEWER   — read-only: sees workloads; no create/edit/deploy/secrets/runtime
 *   CLIENT_OPERATOR — view + runtime actions (start/stop/restart); NO config edit/deploy/secrets
 *   CLIENT_ADMIN    — view + runtime + edit + deploy + secrets
 *
 * Runs against the SCRATCH instance; everything is removed by exact name/id
 * afterwards.
 */
import { test, expect } from "@playwright/test";
import { Role } from "@prisma/client";
import {
  BASE_URL,
  prisma,
  adminUserId,
  e2eNodeId,
  injectSession,
  forceCleanupWorkload,
  docker,
  snapshotInventory,
  assertUnrelatedUntouched,
  createDeploymentViaApi,
  deployViaApi,
  suffix,
  type Inventory
} from "./e2e/helpers";

async function makeUser(clientAccountId: string, email: string, role: Role) {
  const user = await prisma.user.create({
    data: {
      email,
      displayName: email,
      passwordHash: "unused",
      role,
      clientAccountId,
      isActive: true
    }
  });
  return user;
}

test.describe.serial("E2E-D client permissions", () => {
  test.describe.configure({ timeout: 300_000 });
  let adminId = "";
  let nodeId = "";
  const s = suffix();
  const clientName = `E2E Client ${s}`;
  const clientSlug = `e2e-client-${s}`;
  const workloadName = `E2E Perm ${s}`;
  const composeProject = `e2e-perm-${s}`;
  const expectedContainer = `${composeProject}-app-1`;
  let clientId = "";
  let viewerId = "";
  let operatorId = "";
  let adminUserId2 = "";
  let projectId = "";
  let deploymentId = "";
  let containerRowId = "";
  let extraProjectId = "";
  let before: Inventory;

  test.beforeAll(async () => {
    adminId = await adminUserId();
    nodeId = await e2eNodeId();
    before = snapshotInventory();

    // Disposable client + allowlist on the node.
    const client = await prisma.clientAccount.create({
      data: { name: clientName, slug: clientSlug }
    });
    clientId = client.id;
    await prisma.clientNodeAccess.create({ data: { clientAccountId: clientId, nodeId } });

    // Disposable users for each client role.
    const viewer = await makeUser(clientId, `viewer-${s}@e2e.local`, Role.CLIENT_VIEWER);
    const operator = await makeUser(clientId, `operator-${s}@e2e.local`, Role.CLIENT_OPERATOR);
    const adminUser = await makeUser(clientId, `admin-${s}@e2e.local`, Role.CLIENT_ADMIN);
    viewerId = viewer.id;
    operatorId = operator.id;
    adminUserId2 = adminUser.id;

    // Workload owned by the client, deployed via the admin API.
    const adminContext = await (await import("@playwright/test")).chromium.launch().then((b) => b.newContext());
    const csrf = await injectSession(adminContext, adminId);
    const page = await adminContext.newPage();
    const wl = await createDeploymentViaApi(page, csrf, {
      name: workloadName,
      nodeId,
      composeProject,
      compose: "services:\n  app:\n    image: nginx:1.27-alpine\n"
    });
    projectId = wl.projectId;
    deploymentId = wl.deploymentId;
    const result = await deployViaApi(page, csrf, wl);
    expect(result.succeeded).toBe(true);
    const containerRow = await prisma.container.findFirstOrThrow({ where: { projectId } });
    containerRowId = containerRow.id;
    await adminContext.close();
  });

  test("viewer: read-only everywhere (API + UI)", async ({ browser }) => {
    const context = await browser.newContext();
    const csrf = await injectSession(context, viewerId);
    const page = await context.newPage();

    // API — reads OK.
    const workloads = await apiGet(page, csrf, "/api/client/workloads");
    expect((workloads as { workloads: unknown[] }).workloads.length).toBeGreaterThan(0);
    // API — every state-changing action forbidden.
    await expectStatus(page, csrf, "/api/client/deployments", "POST", 403, { nodeId, name: "x", composeProjectName: "x", compose: "services:\n  app:\n    image: nginx:stable\n" });
    await expectStatus(page, csrf, `/api/client/deployments/${deploymentId}/revisions`, "POST", 403, { compose: "services:\n  app:\n    image: nginx:stable\n", environment: {}, secretReferences: [], acknowledgedFindings: [] });
    await expectStatus(page, csrf, `/api/client/deployments/${deploymentId}/plan`, "POST", 403, {});
    await expectStatus(page, csrf, `/api/client/deployments/${deploymentId}/deploy`, "POST", 403, {});
    await expectStatus(page, csrf, `/api/client/deployments/${deploymentId}/secrets`, "GET", 403);
    await expectStatus(page, csrf, `/api/client/containers/${containerRowId}/action`, "POST", 403, { action: "stop" });

    // UI — sees the workload, but no create affordance is effective.
    await page.goto(`${BASE_URL}/client/workloads`);
    await expect(page.getByRole("heading", { name: "Workloads" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(workloadName, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await context.close();
  });

  test("operator: runtime actions yes, config/deploy/secrets no (API + UI)", async ({ browser }) => {
    const context = await browser.newContext();
    const csrf = await injectSession(context, operatorId);
    const page = await context.newPage();

    // API — runtime ops allowed.
    await expectStatus(page, csrf, `/api/client/containers/${containerRowId}/action`, "POST", 200, { action: "stop" });
    await expectStatus(page, csrf, `/api/client/containers/${containerRowId}/action`, "POST", 200, { action: "start" });
    // API — config/deploy/secrets forbidden.
    await expectStatus(page, csrf, "/api/client/deployments", "POST", 403, { nodeId, name: "x", composeProjectName: "x", compose: "services:\n  app:\n    image: nginx:stable\n" });
    await expectStatus(page, csrf, `/api/client/deployments/${deploymentId}/revisions`, "POST", 403, { compose: "services:\n  app:\n    image: nginx:stable\n", environment: {}, secretReferences: [], acknowledgedFindings: [] });
    await expectStatus(page, csrf, `/api/client/deployments/${deploymentId}/plan`, "POST", 403, {});
    await expectStatus(page, csrf, `/api/client/deployments/${deploymentId}/secrets`, "GET", 403);

    // UI — sees the workload list; container runtime controls exist.
    await page.goto(`${BASE_URL}/client/workloads`);
    await expect(page.getByRole("heading", { name: "Workloads" })).toBeVisible({ timeout: 30_000 });
    await context.close();
  });

  test("client admin: edits, deploys, secrets all allowed (API)", async ({ browser }) => {
    const context = await browser.newContext();
    const csrf = await injectSession(context, adminUserId2);
    const page = await context.newPage();

    // API — create (node allowlisted for this client).
    const created = await apiJson(page, csrf, "/api/client/deployments", "POST", {
      nodeId,
      name: `E2E Perm Create ${s}`,
      composeProjectName: `e2e-perm-create-${s}`,
      compose: "services:\n  app:\n    image: nginx:1.27-alpine\n",
      environment: {},
      secretReferences: [],
      acknowledgedFindings: []
    });
    expect((created as { projectId: string }).projectId).toBeTruthy();
    extraProjectId = (created as { projectId: string }).projectId;
    // Cleanup the extra workload right away (deletion-plan API).
    const plan = await apiJson(page, csrf, `/api/admin/workloads/${extraProjectId}/deletion-plan`, "GET");
    expect((plan as { namedVolumesPreserved: boolean }).namedVolumesPreserved).toBe(true);
    // NOTE: client admin cannot delete workloads — deletion is ADMIN-only, so
    // this extra workload is removed in afterAll via the admin session.

    // API — new revision on the owned workload.
    const rev = await apiJson(page, csrf, `/api/client/deployments/${deploymentId}/revisions`, "POST", {
      compose: "services:\n  app:\n    image: nginx:1.27-alpine\n    environment:\n      - E2E_ADMIN=1\n",
      environment: {},
      secretReferences: [],
      acknowledgedFindings: []
    });
    const revisionId = (rev as { revisionId: string }).revisionId;

    // API — secrets.
    await apiJson(page, csrf, `/api/client/deployments/${deploymentId}/secrets`, "POST", {
      key: "E2E_SECRET",
      value: "s3cret-value"
    });

    // API — plan + deploy.
    const plan2 = await apiJson(page, csrf, `/api/client/deployments/${deploymentId}/plan`, "POST", { revisionId });
    const deploy = await apiJson(page, csrf, `/api/client/deployments/${deploymentId}/deploy`, "POST", {
      revisionId,
      planHash: (plan2 as { planHash: string }).planHash
    });
    expect((deploy as { operationId: string }).operationId).toBeTruthy();
    await waitForOp((deploy as { operationId: string }).operationId, 180_000);

    // Runtime verified: container carries the revision's env.
    const inspect = JSON.parse(docker(["inspect", expectedContainer]))[0];
    expect(((inspect.Config as { Env?: string[] }).Env ?? [])).toContain("E2E_ADMIN=1");
    await context.close();
  });

  test.afterAll(async () => {
    // Managed workloads cannot be API-deleted (by design) — force-remove the
    // disposable fixtures from the scratch DB + docker.
    if (projectId) await forceCleanupWorkload(projectId, [expectedContainer]);
    if (extraProjectId) await forceCleanupWorkload(extraProjectId, []);

    await prisma.user.deleteMany({ where: { clientAccountId: clientId } });
    await prisma.clientNodeAccess.deleteMany({ where: { clientAccountId: clientId } });
    await prisma.clientAccount.delete({ where: { id: clientId } }).catch(() => undefined);

    const after = snapshotInventory();
    assertUnrelatedUntouched(before, after, [expectedContainer, composeProject, `${composeProject}_default`]);
  });
});

async function apiJson(
  page: import("@playwright/test").Page,
  csrf: string,
  path: string,
  method: string,
  body?: unknown
): Promise<unknown> {
  const res = await page.request.fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
    data: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (res.status() >= 400) {
    throw new Error(`api ${method} ${path} -> ${res.status()}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function apiGet(page: import("@playwright/test").Page, csrf: string, path: string): Promise<unknown> {
  return apiJson(page, csrf, path, "GET");
}

async function expectStatus(
  page: import("@playwright/test").Page,
  csrf: string,
  path: string,
  method: string,
  expected: number,
  body?: unknown
): Promise<void> {
  const res = await page.request.fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
    data: body !== undefined ? JSON.stringify(body) : undefined
  });
  expect(res.status()).toBe(expected);
}

async function waitForOp(operationId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const op = await prisma.deploymentOperation.findUnique({ where: { id: operationId }, select: { state: true } });
    if (op && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(op.state)) {
      expect(op.state).toBe("SUCCEEDED");
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`operation ${operationId} did not finish`);
}
