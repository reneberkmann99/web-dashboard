import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config({ path: ".env" });

const prisma = new PrismaClient();
const baseURL = process.env.HOSTPANEL_URL ?? "https://localhost:1337";
const DESKTOP = { width: 1440, height: 900 };

let adminToken = "";
let container: { dockerContainerId: string; nodeId: string; dockerName: string } | null = null;

async function useSession(context: BrowserContext): Promise<void> {
  await context.addCookies([{ name: "hostpanel_session", value: adminToken, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}

async function gotoDesktop(page: Page, path: string): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.goto(`${baseURL}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
}

test.beforeAll(async () => {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
  if (!admin) throw new Error("Desktop review suite requires an active admin");
  adminToken = crypto.randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      userId: admin.id,
      tokenHash: crypto.createHash("sha256").update(adminToken).digest("hex"),
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000)
    }
  });
  container = await prisma.container.findFirst({
    where: { isActive: true, node: { isActive: true } },
    orderBy: { dockerName: "asc" },
    select: { dockerContainerId: true, nodeId: true, dockerName: true }
  });
});

test.afterAll(async () => {
  if (adminToken) {
    await prisma.session.deleteMany({ where: { tokenHash: crypto.createHash("sha256").update(adminToken).digest("hex") } });
  }
  await prisma.$disconnect();
});

test.beforeEach(async ({ context, page }) => {
  await useSession(context);
  await page.setViewportSize(DESKTOP);
});

test("desktop shell collapses, persists, and exposes real freshness", async ({ page }) => {
  await gotoDesktop(page, "/admin/containers");
  const sidebar = page.locator("aside[data-sidebar-collapsed]");
  await expect(sidebar).toHaveAttribute("data-sidebar-collapsed", "false");
  await expect(page.locator("[data-desktop-topbar]")).toHaveCSS("height", "52px");
  await expect(page.locator("[data-freshness-state]")).toHaveAttribute("data-freshness-state", /live|stale|unavailable/);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toHaveAttribute("data-sidebar-collapsed", "true");
  await expect(sidebar).toHaveCSS("width", "64px");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("aside[data-sidebar-collapsed]")).toHaveAttribute("data-sidebar-collapsed", "true");
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.locator("aside[data-sidebar-collapsed]")).toHaveCSS("width", "264px");
  await page.getByRole("button", { name: "Open account menu" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Profile" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Log out" })).toBeVisible();
  await expect(menu.getByText(/API keys|Theme|Settings/)).toHaveCount(0);
});

test("desktop filter chips persist in URL and browser history", async ({ page }) => {
  await gotoDesktop(page, "/admin/containers");
  const bar = page.locator("[data-desktop-filter-bar]");
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Add filter" }).click();
  await bar.getByRole("button", { name: "State" }).click();
  await bar.getByRole("button", { name: "running", exact: true }).click();
  await expect(page).toHaveURL(/status=running/);
  await expect(bar.getByRole("button", { name: /Remove State filter running/ })).toBeVisible();
  await bar.getByRole("searchbox", { name: "Search containers…" }).fill("__desktop-review-no-match__");
  await expect(page).toHaveURL(/search=__desktop-review-no-match__/);
  await expect(bar.locator("[data-result-count]")).toContainText(/0 (of \d+|results)/);
  await page.goBack();
  await expect(page).toHaveURL(/status=running/);
  await expect(bar.getByRole("searchbox", { name: "Search containers…" })).toHaveValue("");
  await page.goForward();
  await expect(bar.getByRole("searchbox", { name: "Search containers…" })).toHaveValue("__desktop-review-no-match__");
});

test("canonical desktop table is dense, sticky, and supports bulk selection", async ({ page }) => {
  await gotoDesktop(page, "/admin/containers");
  const tableFamily = page.locator("[data-desktop-table]");
  await expect(tableFamily).toBeVisible();
  const table = tableFamily.locator("table");
  const header = table.locator("thead");
  await expect(header).toHaveCSS("position", "sticky");
  const firstRow = table.locator("tbody tr").first();
  await expect(firstRow).toBeVisible({ timeout: 20_000 });
  const box = await firstRow.boundingBox();
  expect(box?.height ?? 0).toBeLessThanOrEqual(48);
  await firstRow.getByRole("checkbox").check();
  const bulk = page.locator("[data-bulk-action-bar]");
  await expect(bulk).toBeVisible();
  await expect(bulk).toContainText("1 selected");
  await expect(bulk.getByRole("button", { name: "Clear selection" })).toBeVisible();
  await bulk.getByRole("button", { name: "Clear selection" }).click();
  await expect(bulk).toBeHidden();
});

test("inventory tables omit dead columns and keep node counts distinct", async ({ page }) => {
  for (const route of ["/admin/workloads", "/admin/containers", "/admin/clients"]) {
    await gotoDesktop(page, route);
    const table = page.locator("[data-desktop-table] table");
    await expect(table).toBeVisible({ timeout: 30_000 });
    const dead = await table.evaluate((element) => {
      const headers = Array.from(element.querySelectorAll("thead th"));
      return headers.flatMap((header, index) => {
        const label = header.textContent?.trim() ?? "";
        if (!label) return [];
        const values = Array.from(element.querySelectorAll(`tbody tr td:nth-child(${index + 1})`)).map((cell) => cell.textContent?.trim() ?? "");
        return values.length > 0 && values.every((value) => value === "" || value === "—") ? [label] : [];
      });
    });
    expect(dead, `${route} rendered all-empty columns`).toEqual([]);
  }

  await gotoDesktop(page, "/admin/nodes");
  const nodeTable = page.locator("[data-desktop-table] table");
  await expect(nodeTable.getByRole("columnheader", { name: "Containers" })).toBeVisible();
  await expect(nodeTable.getByRole("columnheader", { name: "Workloads" })).toBeVisible();
});

test("container labels disclose safely and logs wrap independently", async ({ page }) => {
  test.skip(!container, "No active container is available");
  await gotoDesktop(page, `/admin/containers/${container!.nodeId}/${container!.dockerContainerId}`);
  const pane = page.locator("[data-sticky-log-pane]");
  await expect(pane).toHaveCSS("position", "sticky");
  await expect(pane).toHaveCSS("overflow", "hidden");
  const wrap = pane.getByRole("button", { name: /Wrap off/ });
  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  await wrap.click();
  await expect(pane.locator("[data-log-wrap='on']")).toBeVisible();

  const labels = page.getByRole("button", { name: /^Labels \(\d+\)$/ });
  if (await labels.count()) {
    await expect(labels).toHaveAttribute("aria-expanded", "false");
    await labels.click();
    await expect(labels).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: "Copy all as JSON" })).toBeVisible();
  }
});

test("attention distinguishes filtered no-match from an unfiltered all-clear", async ({ page }) => {
  await gotoDesktop(page, "/admin/attention?q=__desktop-review-no-match__");
  await expect(page.getByText("No conditions match these filters.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear filters" })).toBeVisible();
});
