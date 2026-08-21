/**
 * E2E workflow C — compose adoption.
 *
 * Creates a disposable two-service compose stack OUTSIDE Noderaft, discovers
 * it via /admin/compose, adopts it, verifies NO adoption-time recreation
 * (container IDs + StartedAt unchanged), verifies the adopted definition is
 * form-editable (services/ports/env/volumes/networks as structured fields),
 * edits through the form, deploys and verifies the runtime.
 *
 * Tear-down by exact compose project name + workload deletion via the
 * deletion-plan API. Never compose down -v.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
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
  snapshotInventory,
  assertUnrelatedUntouched,
  suffix,
  type Inventory
} from "./e2e/helpers";

test.describe.serial("E2E-C compose adoption", () => {
  test.describe.configure({ timeout: 300_000 });
  let adminId = "";
  let nodeId = "";
  const s = suffix();
  const projectName = `noderaft-e2e-c-${s}`;
  const stackDir = `/tmp/noderaft-e2e/stacks/${projectName}`;
  const workloadName = `E2E Stack ${s}`;
  const webContainer = `${projectName}-web-1`;
  const workerContainer = `${projectName}-worker-1`;
  const networkName = `${projectName}_default`;
  const idsBefore: Record<string, { id: string; startedAt: string }> = {};
  let projectId = "";
  let deploymentId = "";
  let before: Inventory;

  test.beforeAll(async () => {
    adminId = await adminUserId();
    nodeId = await e2eNodeId();
    before = snapshotInventory();

    // Disposable compose stack (two tiny services) OUTSIDE Noderaft.
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(
      path.join(stackDir, "compose.yml"),
      [
        "services:",
        "  web:",
        "    image: nginx:1.27-alpine",
        '    ports:',
        '      - "127.0.0.1:19082:80"',
        "  worker:",
        "    image: alpine:3.20",
        '    command: ["sleep", "3600"]',
        ""
      ].join("\n")
    );
    docker(["compose", "-p", projectName, "-f", path.join(stackDir, "compose.yml"), "up", "-d"]);
    const web = containerState(webContainer);
    const worker = containerState(workerContainer);
    expect(web.running).toBe(true);
    expect(worker.running).toBe(true);
    idsBefore[webContainer] = { id: web.id, startedAt: web.startedAt };
    idsBefore[workerContainer] = { id: worker.id, startedAt: worker.startedAt };
  });

  test("discover → adopt (no recreation) → form editor shows structured services → edit → deploy", async ({ browser }) => {
    const context = await browser.newContext();
    const csrf = await injectSession(context, adminId);
    const page = await context.newPage();

    // --- discover ---
    await page.goto(`${BASE_URL}/admin/compose`);
    await expect(page.getByRole("heading", { name: /Discover/i })).toBeVisible({ timeout: 30_000 });
    await page.getByText(projectName, { exact: false }).first().waitFor({ timeout: 60_000 });

    // --- adopt via the wizard ---
    await page.getByRole("button", { name: "Review & adopt" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Workload name").fill(workloadName);
    await page.getByRole("button", { name: /adopt/i }).last().click();

    // Workload exists + managed definition was captured (Phase B).
    await expect
      .poll(() => prisma.project.count({ where: { name: workloadName } }), { timeout: 60_000 })
      .toBeGreaterThan(0);
    const project = await prisma.project.findFirstOrThrow({ where: { name: workloadName } });
    projectId = project.id;
    const deployment = await prisma.deployment.findUniqueOrThrow({ where: { projectId } });
    deploymentId = deployment.id;
    expect(deployment.runtimeState).toBe("CONVERGED");
    const revision = await prisma.deploymentRevision.findFirstOrThrow({
      where: { deploymentId },
      orderBy: { revisionNumber: "desc" }
    });
    expect(revision.composeSource).toContain("web:");
    expect(revision.composeSource).toContain("worker:");

    // --- verify NO adoption-time recreation ---
    for (const name of [webContainer, workerContainer]) {
      const after = containerState(name);
      expect(after.id).toBe(idsBefore[name].id);
      expect(after.startedAt).toBe(idsBefore[name].startedAt);
      expect(after.running).toBe(true);
    }
    const afterAdopt = snapshotInventory();
    assertUnrelatedUntouched(before, afterAdopt, [webContainer, workerContainer, networkName]);

    // --- form editor shows BOTH services as structured fields ---
    await page.goto(`${BASE_URL}/admin/workloads/${projectId}/deployment/edit`);
    await expect(page.getByRole("heading", { name: /Edit configuration/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "web", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "worker", exact: true })).toBeVisible();
    const imageField = page.getByLabel("Image");
    await expect(imageField).toHaveValue(/nginx/);

    // --- edit through the form: change web image, add env on worker ---
    await imageField.fill("nginx:1.29-alpine");
    await page.getByRole("button", { name: "worker", exact: true }).click();
    await page.getByRole("tab", { name: "Environment", exact: true }).click();
    await page.getByRole("button", { name: "Add variable" }).click();
    await page.getByLabel("Key").last().fill("ROLE");
    await page.getByLabel("Value").last().fill("worker");

    await page.getByRole("button", { name: "Validate", exact: true }).click();
    await expect(page.getByText("Validation valid")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Save as new revision" }).click();
    await page.getByRole("button", { name: "Generate deployment plan" }).click();
    await expect(page.getByRole("button", { name: /Deploy revision \d+/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Deploy revision \d+/ }).click();
    await waitForDeploySuccess(deploymentId, 240_000);

    // --- verify runtime ---
    const webState = containerState(webContainer);
    expect(webState.running).toBe(true);
    const webInspect = dockerInspect(webContainer);
    expect(String((webInspect.Config as { Image?: string }).Image ?? "")).toContain("nginx:1.29-alpine");
    const workerInspect = dockerInspect(workerContainer);
    const env = (workerInspect.Config as { Env?: string[] }).Env ?? [];
    expect(env).toContain("ROLE=worker");

    const afterDeploy = snapshotInventory();
    assertUnrelatedUntouched(before, afterDeploy, [webContainer, workerContainer, networkName]);
    await context.close();
  });

  test.afterAll(async () => {
    // Force-remove the adopted compose-stack fixture (managed workloads
    // cannot be API-deleted by design), then tear down the stack by exact
    // project name (NO -v, NO wildcards).
    if (projectId) {
      await forceCleanupWorkload(projectId, [webContainer, workerContainer]);
    }
    docker(["compose", "-p", projectName, "-f", path.join(stackDir, "compose.yml"), "down"]);
    const after = snapshotInventory();
    assertUnrelatedUntouched(before, after, [webContainer, workerContainer, networkName]);
  });
});

async function waitForDeploySuccess(deploymentId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const op = await prisma.deploymentOperation.findFirst({
      where: { deploymentId },
      orderBy: { requestedAt: "desc" },
      select: { state: true, error: true }
    });
    if (op && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(op.state)) {
      expect(op.state).toBe("SUCCEEDED");
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`deploy on ${deploymentId} did not finish within ${timeoutMs}ms`);
}
