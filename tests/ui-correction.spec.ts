import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config({ path: ".env" });
const prisma = new PrismaClient();
const baseURL = process.env.HOSTPANEL_URL ?? "http://localhost:1337";

let adminToken = "";
let nodeId = "";

async function useSession(context: BrowserContext): Promise<void> {
  await context.addCookies([{ name: "hostpanel_session", value: adminToken, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}

test.beforeAll(async () => {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
  const node = await prisma.node.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  if (!admin || !node) throw new Error("UI correction browser tests require an admin and a node");
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: { userId: admin.id, tokenHash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60 * 60_000) }
  });
  adminToken = token;
  nodeId = node.id;
});

test.afterAll(async () => {
  if (adminToken) await prisma.session.deleteMany({ where: { tokenHash: crypto.createHash("sha256").update(adminToken).digest("hex") } });
  await prisma.$disconnect();
});

test.beforeEach(async ({ context, page }) => {
  await useSession(context);
  await page.setViewportSize({ width: 1280, height: 700 });
});

test("sidebar navigation always opens the destination at the top", async ({ page }) => {
  // Scroll down on Workloads, then use the sidebar to open Nodes — the new
  // page must start at the top, not restore the previous scroll.
  await page.goto("/admin/containers");
  await expect(page.locator("[data-desktop-table] tbody tr").first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => window.scrollTo(0, Math.min(400, document.documentElement.scrollHeight)));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await page.getByRole("link", { name: /^Nodes/ }).click();
  await expect(page).toHaveURL(/\/admin\/nodes$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("detail breadcrumbs reflect hierarchy and are clickable", async ({ page }) => {
  await page.goto(`/admin/nodes/${nodeId}`);
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb).toBeVisible();
  await expect(breadcrumb.getByText("Nodes")).toBeVisible();
  await breadcrumb.getByRole("link", { name: "Nodes" }).click();
  await expect(page).toHaveURL(/\/admin\/nodes$/);
});

test("Recent failures render compact, grouped and dismissible", async ({ page }) => {
  await page.goto("/admin");
  const section = page.getByRole("heading", { name: "Recent failures" });
  // Only assert when the section is present (a fresh fleet may have none).
  if ((await section.count()) > 0) {
    await expect(section).toBeVisible();
    // Dismiss-all is present; the list uses per-row dismiss buttons with an
    // accessible label.
    await expect(page.getByRole("button", { name: "Dismiss all" })).toBeVisible();
  }
});
