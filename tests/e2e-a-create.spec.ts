/**
 * E2E workflow A — admin creates a workload via the FORM wizard, deploys it,
 * edits image/env/restart-policy through the form editor, reviews the diff,
 * deploys again and verifies the runtime actually changed.
 *
 * Runs against the SCRATCH instance (localhost:3200) with its own agent
 * driving the REAL local docker daemon. Fixtures are unique-named and removed
 * by exact name afterwards.
 */
import { test, expect } from "@playwright/test";
import {
  BASE_URL,
  prisma,
  adminUserId,
  e2eNodeId,
  injectSession,
  newAdminSession,
  adminFetch,
  docker,
  dockerInspect,
  containerState,
  snapshotInventory,
  assertUnrelatedUntouched,
  suffix,
  type Inventory
} from "./e2e/helpers";

test.describe.serial("E2E-A form-based creation + edit + redeploy", () => {
  test.describe.configure({ timeout: 300_000 });
  let adminId = "";
  let nodeId = "";
  const s = suffix();
  const workloadName = `E2E Form ${s}`;
  const slug = `e2e-form-${s}`;
  const expectedContainer = `${slug}-app-1`;
  let projectId = "";
  let deploymentId = "";
  let before: Inventory;

  test.beforeAll(async () => {
    adminId = await adminUserId();
    nodeId = await e2eNodeId();
    before = snapshotInventory();
  });

  test("create via form wizard and deploy", async ({ browser }) => {
    const context = await browser.newContext();
    const csrf = await injectSession(context, adminId);
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/admin/workloads/new`);
    await expect(page.getByRole("heading", { name: "New workload" })).toBeVisible({ timeout: 30_000 });

    // --- basics: name → node ---
    await page.locator("#cw-name").fill(workloadName);
    await page.selectOption("#cw-node", nodeId);
    await page.getByRole("button", { name: "Continue to services" }).click();

    // --- services: Form tab, set the image ---
    await expect(page.getByRole("tab", { name: "Form", exact: true })).toBeVisible({ timeout: 15_000 });
    const imageField = page.getByLabel("Image");
    await imageField.fill("nginx:1.27-alpine");
    await expect(imageField).toHaveValue("nginx:1.27-alpine");

    // --- validate + review ---
    await page.getByRole("button", { name: "Validate", exact: true }).click();
    await expect(page.getByText("Validation valid")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Review & create" }).click();
    await expect(page.getByText("Review before creating")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Create workload", exact: true }).click();

    // --- plan → deploy (wizard continues into the standard pipeline) ---
    await expect(page.getByRole("button", { name: "Deploy this workload" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Deploy this workload" }).click();

    // Wait for the deploy operation to finish (DB-backed, avoids UI flake).
    const project = await prisma.project.findFirstOrThrow({ where: { name: workloadName } });
    projectId = project.id;
    const deployment = await prisma.deployment.findUniqueOrThrow({ where: { projectId } });
    deploymentId = deployment.id;
    await waitForDeploySuccess(deploymentId, 180_000);

    // --- verify runtime: container is running with the form's image ---
    const names = docker(["ps", "-a", "--format", "{{.Names}}"]);
    expect(names).toContain(expectedContainer);
    const state = containerState(expectedContainer);
    expect(state.running).toBe(true);
    const inspect = dockerInspect(expectedContainer);
    expect(String((inspect.Config as { Image?: string }).Image ?? "")).toContain("nginx:1.27-alpine");
    const afterCreate = snapshotInventory();
    assertUnrelatedUntouched(before, afterCreate, [expectedContainer, slug, `${slug}_default`]);
    await context.close();
  });

  test("edit image/env/restart via form, preview diff, redeploy, verify runtime changed", async ({ browser }) => {
    const context = await browser.newContext();
    const csrf = await injectSession(context, adminId);
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/admin/workloads/${projectId}/deployment/edit`);
    await expect(page.getByRole("heading", { name: /Edit configuration/ })).toBeVisible({ timeout: 30_000 });

    // Form tab is the default — change the image.
    const imageField = page.getByLabel("Image");
    await expect(imageField).toBeVisible({ timeout: 30_000 });
    await imageField.fill("nginx:1.29-alpine");
    await expect(imageField).toHaveValue("nginx:1.29-alpine");

    // Restart policy → always (under the Runtime tab).
    await page.getByRole("tab", { name: "Runtime", exact: true }).click();
    await page.getByLabel("Restart policy").selectOption("always");

    // Environment tab → add FOO=bar.
    await page.getByRole("tab", { name: "Environment", exact: true }).click();
    await page.getByRole("button", { name: "Add variable" }).click();
    await page.getByLabel("Key").last().fill("FOO");
    await page.getByLabel("Value").last().fill("bar");

    // Validate → save revision → review diff → plan → deploy.
    await page.getByRole("button", { name: "Validate", exact: true }).click();
    await expect(page.getByText("Validation valid")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Save as new revision" }).click();
    await expect(page.getByText("Changes vs", { exact: false })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Generate deployment plan" }).click();
    await expect(page.getByRole("button", { name: /Deploy revision \d+/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Deploy revision \d+/ }).click();
    await waitForDeploySuccess(deploymentId, 180_000);

    // --- verify runtime changed (poll: the container recreate settles a beat
    // after the operation is recorded as SUCCEEDED) ---
    await expect
      .poll(
        async () => {
          const inspect = dockerInspect(expectedContainer);
          const image = String((inspect.Config as { Image?: string }).Image ?? "");
          const env = (inspect.Config as { Env?: string[] }).Env ?? [];
          const restartPolicy = (inspect.HostConfig as { RestartPolicy?: { Name?: string } }).RestartPolicy?.Name;
          return { image, foo: env.includes("FOO=bar"), restart: restartPolicy };
        },
        { timeout: 60_000, intervals: [1000, 2000, 5000] }
      )
      .toEqual({ image: expect.stringContaining("nginx:1.29-alpine"), foo: true, restart: "always" });

    const afterEdit = snapshotInventory();
    assertUnrelatedUntouched(before, afterEdit, [expectedContainer, slug, `${slug}_default`]);
    await context.close();
  });

  test.afterAll(async () => {
    // Cleanup: delete the workload via the deletion-plan API, then verify the
    // container is gone and nothing unrelated changed.
    if (projectId) {
      const { token, csrf } = await newAdminSession();
      const plan = await adminFetch<{ namedVolumesPreserved: boolean }>(token, csrf, `/api/admin/workloads/${projectId}/deletion-plan`);
      expect(plan.namedVolumesPreserved).toBe(true);
      await adminFetch(token, csrf, `/api/admin/workloads/${projectId}`, { method: "DELETE", expectStatus: 200 });
      const after = snapshotInventory();
      assertUnrelatedUntouched(before, after, [expectedContainer, slug, `${slug}_default`]);
      expect(docker(["ps", "-a", "--format", "{{.Names}}"])).not.toContain(expectedContainer);
    }
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
