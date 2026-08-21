/**
 * E2E workflow E — deletion lifecycle.
 *
 *  1. Managed service removal: two-service workload → remove one service via
 *     the API → plan → deploy → the service's container is removed, the
 *     named volume is PRESERVED.
 *  2. Workload delete: deletion plan → containers removed, named volumes and
 *     external networks PRESERVED, unrelated objects untouched.
 *  3. User lifecycle: deactivate (login refused) → reactivate (login works)
 *     → delete (row gone).
 *
 * Runs against the SCRATCH instance; all fixtures removed by exact name/id.
 */
import { test, expect } from "@playwright/test";
import { Role } from "@prisma/client";
import { hashPassword } from "@/server/auth/password";
import {
  BASE_URL,
  prisma,
  adminUserId,
  e2eNodeId,
  injectSession,
  forceCleanupWorkload,
  docker,
  dockerInspect,
  containerState,
  volumeNames,
  snapshotInventory,
  assertUnrelatedUntouched,
  createDeploymentViaApi,
  deployViaApi,
  suffix,
  type Inventory
} from "./e2e/helpers";

test.describe.serial("E2E-E deletion lifecycle", () => {
  test.describe.configure({ timeout: 300_000 });
  let adminId = "";
  let nodeId = "";
  const s = suffix();
  const workloadName = `E2E Del ${s}`;
  const composeProject = `e2e-del-${s}`;
  const appContainer = `${composeProject}-app-1`;
  const sidecarContainer = `${composeProject}-sidecar-1`;
  const namedVolume = `${composeProject}_e2e-data`;
  let projectId = "";
  let deploymentId = "";
  let revisionId = "";
  let before: Inventory;

  test.beforeAll(async () => {
    adminId = await adminUserId();
    nodeId = await e2eNodeId();
    before = snapshotInventory();

    const context = await (await import("@playwright/test")).chromium.launch().then((b) => b.newContext());
    const csrf = await injectSession(context, adminId);
    const page = await context.newPage();
    const compose = [
      "services:",
      "  app:",
      "    image: nginx:1.27-alpine",
      "    volumes:",
      "      - e2e-data:/data",
      "  sidecar:",
      "    image: alpine:3.20",
      '    command: ["sleep", "3600"]',
      "volumes:",
      "  e2e-data:",
      ""
    ].join("\n");
    const wl = await createDeploymentViaApi(page, csrf, { name: workloadName, nodeId, composeProject, compose });
    projectId = wl.projectId;
    deploymentId = wl.deploymentId;
    revisionId = wl.revisionId;
    const result = await deployViaApi(page, csrf, wl);
    expect(result.succeeded).toBe(true);
    expect(containerState(appContainer).running).toBe(true);
    expect(containerState(sidecarContainer).running).toBe(true);
    expect(volumeNames()).toContain(namedVolume);
    await context.close();
  });

  test("managed service removal: container removed, named volume preserved", async ({ browser }) => {
    const context = await browser.newContext();
    const csrf = await injectSession(context, adminId);
    const page = await context.newPage();

    // Remove the sidecar service (authors a NEW revision via the standard path).
    const removed = await apiJson(page, csrf, `/api/admin/deployments/${deploymentId}/services/sidecar`, "DELETE");
    const newRevisionId = (removed as { revisionId: string }).revisionId;
    expect(newRevisionId).toBeTruthy();

    // Plan + deploy the removal revision.
    const plan = await apiJson(page, csrf, `/api/admin/deployments/${deploymentId}/plan`, "POST", {
      revisionId: newRevisionId
    });
    const op = await apiJson(page, csrf, `/api/admin/deployments/${deploymentId}/deploy`, "POST", {
      revisionId: newRevisionId,
      planHash: (plan as { planHash: string }).planHash
    });
    await waitForOp((op as { operationId: string }).operationId, 240_000);

    // Sidecar container is gone; app still runs; named volume PRESERVED.
    expect(docker(["ps", "-a", "--format", "{{.Names}}"])).not.toContain(sidecarContainer);
    expect(containerState(appContainer).running).toBe(true);
    expect(volumeNames()).toContain(namedVolume);
    const afterRemoval = snapshotInventory();
    assertUnrelatedUntouched(before, afterRemoval, [appContainer, sidecarContainer, namedVolume, composeProject, `${composeProject}_default`]);
    await context.close();
  });

  test("workload delete: managed refused; unmanaged delete removes containers, volumes preserved", async ({ browser }) => {
    const context = await browser.newContext();
    const csrf = await injectSession(context, adminId);
    const page = await context.newPage();

    // 1. Managed workload: the deletion plan is reviewable, but the DELETE is
    // refused by design ("remove it from Noderaft management first").
    const plan = await apiJson(page, csrf, `/api/admin/workloads/${projectId}/deletion-plan`, "GET");
    expect((plan as { managed: boolean }).managed).toBe(true);
    const refused = await page.request.fetch(`${BASE_URL}/api/admin/workloads/${projectId}`, {
      method: "DELETE",
      headers: { "x-csrf-token": csrf }
    });
    expect(refused.status()).toBe(409);

    // 2. Unmanaged workload fixture: a real disposable container linked to a
    // project WITHOUT a deployment → the plan is reviewable and the delete
    // removes the container through the agent.
    const unmanagedName = `noderaft-e2e-unmanaged-${s}`;
    docker(["run", "-d", "--name", unmanagedName, "nginx:1.27-alpine"]);
    const cid = String((dockerInspect(unmanagedName).Id as string) ?? "");
    const proj = await prisma.project.create({
      data: { name: `E2E Unmanaged ${s}`, slug: `e2e-unmanaged-${s}`, source: "MANUAL", nodeId, isActive: true }
    });
    await prisma.container.create({
      data: {
        nodeId,
        dockerContainerId: cid,
        dockerName: unmanagedName,
        image: "nginx:1.27-alpine",
        projectId: proj.id,
        lastKnownStatus: "running",
        isActive: true
      }
    });

    const unmanagedPlan = await apiJson(page, csrf, `/api/admin/workloads/${proj.id}/deletion-plan`, "GET");
    expect((unmanagedPlan as { managed: boolean }).managed).toBe(false);
    await apiJson(page, csrf, `/api/admin/workloads/${proj.id}`, "DELETE");
    expect(docker(["ps", "-a", "--format", "{{.Names}}"])).not.toContain(unmanagedName);
    expect(await prisma.project.findUnique({ where: { id: proj.id } })).toBeNull();

    // The named volume of the (still-managed) workload is untouched by all of this.
    expect(volumeNames()).toContain(namedVolume);
    const after = snapshotInventory();
    assertUnrelatedUntouched(before, after, [appContainer, sidecarContainer, namedVolume, composeProject, `${composeProject}_default`, unmanagedName]);
    await context.close();
  });

  test("user deactivate → reactivate → delete", async ({ browser }) => {
    const password = await hashPassword("E2eUserPass!2026");
    const user = await prisma.user.create({
      data: {
        email: `lifecycle-${s}@e2e.local`,
        displayName: `Lifecycle ${s}`,
        passwordHash: password,
        role: Role.ADMIN,
        isActive: true
      }
    });

    const context = await browser.newContext();
    const csrf = await injectSession(context, adminId);
    const page = await context.newPage();

    // Login probes run in an isolated cookie jar so a successful login
    // never overwrites the admin session cookie shared by `page` (which
    // would poison the CSRF token pairing for subsequent admin calls).
    const loginProbe = await (await import("@playwright/test")).request.newContext({ baseURL: BASE_URL });

    // Deactivate → login refused (403 ACCOUNT_DISABLED — distinct from a bad
    // password's 401 INVALID_CREDENTIALS).
    await apiJson(page, csrf, `/api/admin/users/${user.id}`, "PATCH", { isActive: false });
    const login1 = await loginProbe.post(`${BASE_URL}/api/auth/login`, {
      data: { email: user.email, password: "E2eUserPass!2026" }
    });
    expect(login1.status()).toBe(403);

    // Reactivate → login works.
    await apiJson(page, csrf, `/api/admin/users/${user.id}`, "PATCH", { isActive: true });
    const login2 = await loginProbe.post(`${BASE_URL}/api/auth/login`, {
      data: { email: user.email, password: "E2eUserPass!2026" }
    });
    expect(login2.status()).toBe(200);

    // Delete → row gone, login refused.
    await apiJson(page, csrf, `/api/admin/users/${user.id}`, "DELETE");
    const gone = await prisma.user.findUnique({ where: { id: user.id } });
    expect(gone).toBeNull();
    const login3 = await loginProbe.post(`${BASE_URL}/api/auth/login`, {
      data: { email: user.email, password: "E2eUserPass!2026" }
    });
    expect(login3.status()).toBe(401);
    await loginProbe.dispose();
    await context.close();
  });

  test.afterAll(async () => {
    // Force-remove the managed workload fixture (cannot be API-deleted).
    if (projectId) {
      await forceCleanupWorkload(projectId, [appContainer, sidecarContainer], [`${composeProject}_default`]);
    }
    // Remove the preserved named volume by exact name (our fixture).
    if (volumeNames().includes(namedVolume)) {
      docker(["volume", "rm", namedVolume]);
    }
    const after = snapshotInventory();
    assertUnrelatedUntouched(before, after, [appContainer, sidecarContainer, namedVolume, composeProject, `${composeProject}_default`]);
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
  // Unwrap the standard { ok, data } envelope.
  if (json && typeof json === "object" && (json as { ok?: boolean }).ok === true && "data" in (json as object)) {
    return (json as { data: unknown }).data;
  }
  return json;
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
