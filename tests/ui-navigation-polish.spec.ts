import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config({ path: ".env" });
const prisma = new PrismaClient();
const baseURL = process.env.HOSTPANEL_URL ?? "http://localhost:1337";

let adminToken = "";
let workload: { id: string; name: string; nodeId: string };
let nodeId = "";

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
  const project = await prisma.project.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, nodeId: true } });
  const nodeWithContainer = await prisma.node.findFirst({
    where: { isActive: true, containers: { some: { isActive: true } } },
    orderBy: { name: "asc" },
    select: { id: true }
  });
  if (!admin || !project || !nodeWithContainer) throw new Error("UI polish browser tests require an admin, workload, and node with a container");
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.session.create({ data: { userId: admin.id, tokenHash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60 * 60_000) } });
  adminToken = token;
  workload = project;
  nodeId = nodeWithContainer.id;
});

test.afterAll(async () => {
  if (adminToken) await prisma.session.deleteMany({ where: { tokenHash: crypto.createHash("sha256").update(adminToken).digest("hex") } });
  await prisma.$disconnect();
});

test.beforeEach(async ({ context, page }) => {
  await useSession(context);
  await page.setViewportSize({ width: 1280, height: 500 });
});

test("workload filters, search, and scroll survive browser Back", async ({ page }) => {
  await resetViewState(page, "/admin/workloads");
  await page.getByLabel("Filter by node").selectOption(workload.nodeId);
  await expect(page).toHaveURL(new RegExp(`nodeId=${workload.nodeId}`));
  await page.getByRole("searchbox", { name: "Search workloads…" }).fill(workload.name);
  const row = page.locator(`tr[data-row-key="${workload.id}"]`).filter({ visible: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  const savedScroll = await page.evaluate(() => { window.scrollTo(0, Math.min(220, document.documentElement.scrollHeight)); return window.scrollY; });
  expect(savedScroll).toBeGreaterThan(0);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/admin/workloads/${workload.id}`));
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/workloads$/);
  await expect(page.getByLabel("Filter by node")).toHaveValue(workload.nodeId);
  await expect(page.getByRole("searchbox", { name: "Search workloads…" })).toHaveValue(workload.name);
  await expect(row).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(Math.max(1, savedScroll - 8));
});

test("node Containers tab and scroll survive child-container Back navigation", async ({ page }) => {
  await resetViewState(page, `/admin/nodes/${nodeId}`);
  await page.getByRole("tab", { name: "Containers", exact: true }).click();
  await expect(page).toHaveURL(/tab=containers/);
  const row = page.locator('table[aria-label="Node containers"] tbody tr[role="link"]:visible').first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  const savedScroll = await page.evaluate(() => { window.scrollTo(0, Math.min(240, document.documentElement.scrollHeight)); return window.scrollY; });
  expect(savedScroll).toBeGreaterThan(0);
  await row.click();
  await expect(page).toHaveURL(/\/admin\/containers\//);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/admin/nodes/${nodeId}\\?tab=containers`));
  await expect(page.getByRole("tab", { name: "Containers", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(Math.max(1, savedScroll - 8));
});

test("resource rows open consistently and a node row menu does not navigate", async ({ page }) => {
  await resetViewState(page, "/admin/workloads");
  const workloadRow = page.locator(`tr[data-row-key="${workload.id}"]`).filter({ visible: true });
  await workloadRow.focus();
  await workloadRow.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/admin/workloads/${workload.id}`));

  await resetViewState(page, "/admin/nodes");
  const nodeRow = page.locator(`tr[data-row-key="${nodeId}"]`).filter({ visible: true });
  const currentUrl = page.url();
  await nodeRow.getByRole("button", { name: /Actions for/ }).click();
  await expect(page).toHaveURL(currentUrl);
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await nodeRow.focus();
  await nodeRow.press(" ");
  await expect(page).toHaveURL(new RegExp(`/admin/nodes/${nodeId}`));

  await resetViewState(page, `/admin/nodes/${nodeId}`);
  await page.getByRole("tab", { name: "Containers", exact: true }).click();
  const containerRow = page.locator('table[aria-label="Node containers"] tbody tr[role="link"]:visible').first();
  await containerRow.press("Enter");
  await expect(page).toHaveURL(/\/admin\/containers\//);
});
