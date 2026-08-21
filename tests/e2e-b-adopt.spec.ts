/**
 * E2E workflow B — manual standalone-container adoption.
 *
 * Creates a disposable container OUTSIDE Noderaft (unique name), discovers it
 * through the agent, adopts it ("Manage with Noderaft"), verifies NO
 * adoption-time recreation (ID + StartedAt unchanged, labels only), then
 * edits through the form editor, plans, deploys and verifies the runtime.
 *
 * Runs against the SCRATCH instance; the fixture container is removed by
 * exact name afterwards and the adopted workload is deleted via the
 * deletion-plan API.
 */
import { test, expect } from "@playwright/test";
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

test.describe.serial("E2E-B manual adoption", () => {
  test.describe.configure({ timeout: 300_000 });
  let adminId = "";
  let nodeId = "";
  const s = suffix();
  const containerName = `noderaft-e2e-adopt-${s}`;
  const workloadName = `E2E Adopt ${s}`;
  let containerIdBefore = "";
  let startedAtBefore = "";
  let projectId = "";
  let deploymentId = "";
  let before: Inventory;

  test.beforeAll(async () => {
    adminId = await adminUserId();
    nodeId = await e2eNodeId();
    before = snapshotInventory();
    // Disposable standalone container OUTSIDE Noderaft (unique name).
    docker(["run", "-d", "--name", containerName, "-p", "127.0.0.1:19081:80", "nginx:1.27-alpine"]);
    const st = containerState(containerName);
    containerIdBefore = st.id;
    startedAtBefore = st.startedAt;
    expect(st.running).toBe(true);
  });

  test("discover → adopt without recreation → edit via form → deploy → verify runtime", async ({ browser }) => {
    const context = await browser.newContext();
    const csrf = await injectSession(context, adminId);
    const page = await context.newPage();

    // --- discover: the agent inventory lists the unmanaged container ---
    await page.goto(`${BASE_URL}/admin/containers`);
    await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible({ timeout: 30_000 });
    await page.getByPlaceholder(/search/i).fill(containerName);
    await page.getByText(containerName, { exact: false }).first().waitFor({ timeout: 60_000 });
    // Open the container detail page.
    await page.getByText(containerName, { exact: false }).first().click();
    await expect(page.getByRole("button", { name: "Manage with Noderaft" })).toBeVisible({ timeout: 30_000 });

    // --- adopt (preflight → confirm) ---
    await page.getByRole("button", { name: "Manage with Noderaft" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /adopt|manage with noderaft/i }).last().click();

    // Adoption completes → workload exists.
    await expect
      .poll(() => prisma.project.count({ where: { name: workloadName } }), { timeout: 30_000 })
      .toBeGreaterThan(0);
    const project = await prisma.project.findFirstOrThrow({ where: { name: workloadName } });
    projectId = project.id;
    const deployment = await prisma.deployment.findUniqueOrThrow({ where: { projectId } });
    deploymentId = deployment.id;
    expect(deployment.runtimeState).toBe("CONVERGED");

    // --- verify NO adoption-time recreation ---
    const after = containerState(containerName);
    expect(after.id).toBe(containerIdBefore);
    expect(after.startedAt).toBe(startedAtBefore);
    expect(after.running).toBe(true);
    // Labels only: the live container now carries the adoption marker.
    const labels = (dockerInspect(containerName).Config as { Labels?: Record<string, string> }).Labels ?? {};
    expect(labels["com.noderaft.adopted"]).toBe("true");
    const afterAdopt = snapshotInventory();
    assertUnrelatedUntouched(before, afterAdopt, [containerName]);

    // --- edit through the form editor ---
    await page.goto(`${BASE_URL}/admin/workloads/${projectId}/deployment/edit`);
    await expect(page.getByRole("heading", { name: /Edit configuration/ })).toBeVisible({ timeout: 30_000 });
    const imageField = page.getByLabel("Image");
    await expect(imageField).toBeVisible({ timeout: 30_000 });
    // The adopted definition reproduces the running image.
    await expect(imageField).toHaveValue(/nginx/);
    // Environment tab → add E2E=adopted.
    await page.getByRole("tab", { name: "Environment", exact: true }).click();
    await page.getByRole("button", { name: "Add variable" }).click();
    await page.getByLabel("Key").last().fill("E2E_ADOPTED");
    await page.getByLabel("Value").last().fill("yes");

    await page.getByRole("button", { name: "Validate", exact: true }).click();
    await expect(page.getByText("Validation valid")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Save as new revision" }).click();
    await page.getByRole("button", { name: "Generate deployment plan" }).click();
    await expect(page.getByRole("button", { name: /Deploy revision \d+/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Deploy revision \d+/ }).click();
    await waitForDeploySuccess(deploymentId, 180_000);

    // --- verify runtime ---
    const running = containerState(containerName);
    expect(running.running).toBe(true);
    const inspect = dockerInspect(containerName);
    const env = (inspect.Config as { Env?: string[] }).Env ?? [];
    expect(env).toContain("E2E_ADOPTED=yes");
    const afterDeploy = snapshotInventory();
    assertUnrelatedUntouched(before, afterDeploy, [containerName]);
    await context.close();
  });

  test.afterAll(async () => {
    // Cleanup by exact name: force-remove the adopted workload fixture
    // (managed workloads cannot be API-deleted by design) and the standalone
    // fixture container. Never wildcard.
    if (projectId) {
      await forceCleanupWorkload(projectId, [containerName]);
    }
    if (docker(["ps", "-a", "--format", "{{.Names}}"]).split("\n").includes(containerName)) {
      docker(["rm", "-f", containerName]);
    }
    const after = snapshotInventory();
    assertUnrelatedUntouched(before, after, [containerName]);
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
