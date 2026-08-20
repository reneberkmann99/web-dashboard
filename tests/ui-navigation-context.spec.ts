import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config({ path: ".env" });
const prisma = new PrismaClient();
const baseURL = process.env.HOSTPANEL_URL ?? "http://localhost:1337";

let adminToken = "";
let workload: { id: string; name: string; nodeId: string; nodeName: string };
let container: { id: string; name: string } | null = null;

async function useSession(context: BrowserContext): Promise<void> {
  await context.addCookies([{ name: "hostpanel_session", value: adminToken, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}

async function resetViewState(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload();
}

test.beforeAll(async () => {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
  const project = await prisma.project.findFirst({
    where: { isActive: true, node: { isActive: true } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, nodeId: true, node: { select: { name: true } } }
  });
  if (!admin || !project) throw new Error("navigation-context browser tests require an admin and a workload");
  const containerRow = await prisma.container.findFirst({
    where: { nodeId: project.nodeId, isActive: true },
    orderBy: { dockerName: "asc" },
    select: { id: true, dockerName: true }
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: { userId: admin.id, tokenHash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60 * 60_000) }
  });
  adminToken = token;
  workload = { id: project.id, name: project.name, nodeId: project.nodeId, nodeName: project.node.name };
  container = containerRow ? { id: containerRow.id, name: containerRow.dockerName } : null;
});

test.afterAll(async () => {
  if (adminToken) await prisma.session.deleteMany({ where: { tokenHash: crypto.createHash("sha256").update(adminToken).digest("hex") } });
  await prisma.$disconnect();
});

test.beforeEach(async ({ context, page }) => {
  await useSession(context);
  await page.setViewportSize({ width: 1280, height: 700 });
});

test("cross-section navigation keeps the trail and sidebar origin", async ({ page }) => {
  await resetViewState(page, "/admin/workloads");
  await page.getByRole("link", { name: "Workloads" }).click();
  await expect(page).toHaveURL(/\/admin\/workloads$/);

  // Open a workload from the table.
  await page.locator(`tr[data-row-key="${workload.id}"]`).filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/workloads/${workload.id}`));
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb).toContainText(workload.name);
  // Sidebar still highlights Workloads (navigation origin), not the child route.
  await expect(page.getByRole("link", { name: "Workloads" })).toHaveAttribute("aria-current", "page");

  // Open the node from the workload header.
  await page.getByRole("button", { name: workload.nodeName }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/nodes/${workload.nodeId}`));
  await expect(breadcrumb).toContainText(workload.nodeName);
  await expect(page.getByRole("link", { name: "Workloads" })).toHaveAttribute("aria-current", "page");

  // Containers tab, then a container.
  await page.getByRole("tab", { name: "Containers", exact: true }).click();
  await expect(page).toHaveURL(/tab=containers/);
  await expect(breadcrumb).toContainText("Containers");
  if (container) {
    const row = page.locator('table[aria-label="Node containers"] tbody tr[role="link"]').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page).toHaveURL(/\/admin\/containers\//);
    await expect(breadcrumb).toContainText("Containers");
  }
});

test("clicking a new sidebar root resets the trail", async ({ page }) => {
  await resetViewState(page, "/admin/workloads");
  await page.locator(`tr[data-row-key="${workload.id}"]`).filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/workloads/${workload.id}`));

  await page.getByRole("link", { name: "Nodes" }).click();
  await expect(page).toHaveURL(/\/admin\/nodes$/);
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb).toContainText("Nodes");
  await expect(breadcrumb).not.toContainText(workload.name);
  await expect(page.getByRole("link", { name: "Nodes" })).toHaveAttribute("aria-current", "page");
});

test("breadcrumb click truncates the trail and returns to that context", async ({ page }) => {
  await resetViewState(page, "/admin/workloads");
  await page.locator(`tr[data-row-key="${workload.id}"]`).filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/workloads/${workload.id}`));
  await page.getByRole("button", { name: workload.nodeName }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/nodes/${workload.nodeId}`));

  // Click the workload breadcrumb → back to the workload, trail truncated.
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await breadcrumb.getByRole("link", { name: workload.name }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/workloads/${workload.id}`));
  await expect(breadcrumb).toContainText(workload.name);
  await expect(breadcrumb).not.toContainText(workload.nodeName);
});

test("browser Back restores the breadcrumb and origin", async ({ page }) => {
  await resetViewState(page, "/admin/workloads");
  await page.locator(`tr[data-row-key="${workload.id}"]`).filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/workloads/${workload.id}`));
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb).toContainText(workload.name);

  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/workloads$/);
  await expect(breadcrumb).not.toContainText(workload.name);
  await expect(page.getByRole("link", { name: "Workloads" })).toHaveAttribute("aria-current", "page");
});

test("a direct deep link falls back to a route-derived breadcrumb", async ({ page }) => {
  await resetViewState(page, `/admin/nodes/${workload.nodeId}`);
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb).toContainText("Nodes");
  await expect(page.getByRole("link", { name: "Nodes" })).toHaveAttribute("aria-current", "page");
});
