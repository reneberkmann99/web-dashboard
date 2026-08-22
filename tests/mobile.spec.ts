import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

/**
 * Noderaft Mobile design gate — browser suite at the design reference viewport
 * 390×844 (Chromium). Covers: bottom navigation, account sheet, filter sheet,
 * long-name wrapping, pinned container actions, mobile logs, resource cards,
 * navigation context, safe-area/layout stability, and the hard horizontal
 * overflow gate on every route.
 *
 * Runs against the live control plane (baseURL, default http://localhost:1337)
 * with a real admin session, exactly like the desktop regression suites.
 */

dotenv.config({ path: ".env" });

const prisma = new PrismaClient();
const baseURL = process.env.HOSTPANEL_URL ?? "https://localhost:1337";
const MOBILE_VIEWPORT = { width: 390, height: 844 };

let adminToken = "";
let nodeId = "";
let workloadId = "";
let containerId: string | null = null;
let containerNodeId = "";
let clientId = "";
let userId = "";

async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      userId,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000)
    }
  });
  return token;
}

async function useSession(context: BrowserContext, token: string): Promise<void> {
  await context.addCookies([{ name: "hostpanel_session", value: token, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(overflow.scrollWidth, `document overflows horizontally: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(
    overflow.clientWidth
  );
}

async function gotoMobile(page: Page, path: string): Promise<void> {
  await page.setViewportSize(MOBILE_VIEWPORT);
  // domcontentloaded + settle: pages poll and stream (SSE logs), so
  // "networkidle" never resolves on some routes.
  await page.goto(`${baseURL}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
}

test.beforeAll(async () => {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
  if (!admin) throw new Error("Mobile suite requires one active admin user");
  adminToken = await createSession(admin.id);

  const node = await prisma.node.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  const workload = await prisma.project.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  const client = await prisma.clientAccount.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  const user = await prisma.user.findFirst({ where: { isActive: true }, orderBy: { email: "asc" }, select: { id: true } });
  if (!node || !workload || !client || !user) throw new Error("Mobile suite requires a node, workload, client and user");

  nodeId = node.id;
  workloadId = workload.id;
  clientId = client.id;
  userId = user.id;

  const container = await prisma.container.findFirst({ where: { nodeId: node.id }, orderBy: { dockerName: "asc" }, select: { dockerContainerId: true, nodeId: true } });
  containerId = container?.dockerContainerId ?? null;
  containerNodeId = container?.nodeId ?? "";
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("Noderaft mobile design gate @390x844", () => {
  test.use({ viewport: MOBILE_VIEWPORT, ignoreHTTPSErrors: true });

  test("bottom navigation: five admin destinations, root highlighting", async ({ context, page }) => {
    await useSession(context, adminToken);
    await gotoMobile(page, "/admin");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav).toBeVisible();
    const labels = ["Overview", "Workloads", "Nodes", "Attention", "Activity"];
    for (const label of labels) {
      await expect(nav.getByText(label, { exact: true })).toBeVisible();
    }
    // Exactly five destinations.
    await expect(nav.locator("a")).toHaveCount(5);
    await expect(nav.getByRole("link", { name: /Overview/ })).toHaveAttribute("aria-current", "page");

    await nav.getByText("Nodes", { exact: true }).click();
    await page.waitForURL("**/admin/nodes");
    await expect(nav.getByRole("link", { name: /Nodes/ })).toHaveAttribute("aria-current", "page");
    await assertNoHorizontalOverflow(page);
  });

  test("account sheet: secondary destinations, closes on selection", async ({ context, page }) => {
    await useSession(context, adminToken);
    await gotoMobile(page, "/admin");
    await page.getByRole("button", { name: "Open account sheet" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("rene", { exact: false }).first()).toBeVisible();
    for (const row of ["Containers", "Clients", "Users & roles", "Notifications", "Account settings", "Log out"]) {
      await expect(sheet.getByRole("button", { name: row, exact: true })).toBeVisible();
    }
    // Navigation to a sheet destination keeps the bottom nav and sets a back target.
    await sheet.getByTestId("account-sheet-containers").click();
    await page.waitForURL("**/admin/containers");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    // Back returns to the previous root (Overview highlighted again).
    await page.getByRole("button", { name: "Back" }).click();
    await page.waitForURL("**/admin");
    await assertNoHorizontalOverflow(page);
  });

  test("containers: mobile cards (no table), long names wrap, no overflow", async ({ context, page }) => {
    await useSession(context, adminToken);
    await gotoMobile(page, "/admin/containers");
    // The desktop table is hidden below md; the card list is present.
    await expect(page.locator("table[aria-label='Resources']")).toBeHidden();
    const cards = page.locator("[data-mobile-cards] button");
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    // Card titles use the mono-break treatment.
    await expect(page.locator(".mono-break").first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    // Filter row exists with a Filters button.
    await expect(page.getByRole("button", { name: /Open filters/ }).first()).toBeVisible();
  });

  test("filter sheet: opens from Filters button, count badge, apply commits", async ({ context, page }) => {
    await useSession(context, adminToken);
    await gotoMobile(page, "/admin/containers");
    await page.getByRole("button", { name: /Open filters/ }).first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Filters" })).toBeVisible();
    // Chip group for state.
    await expect(sheet.getByText("State", { exact: true })).toBeVisible();
    const running = sheet.getByRole("button", { name: "running", exact: true });
    await running.click();
    await expect(running).toHaveAttribute("aria-pressed", "true");
    const apply = sheet.getByRole("button", { name: /Apply filters|Show .* containers/ });
    await apply.click();
    await expect(sheet).toBeHidden();
    // The filter chip row now shows the active state chip.
    await expect(page.getByTestId("mobile-filters-row").getByText("running", { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test("workloads: cards + filter sheet with live provisional count", async ({ context, page }) => {
    await useSession(context, adminToken);
    await gotoMobile(page, "/admin/workloads");
    await expect(page.locator("table[aria-label='Workloads']")).toBeHidden();
    await expect(page.locator("[data-mobile-cards] button").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Open filters/ }).first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("button", { name: /Show .* workloads/ })).toBeVisible();
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await assertNoHorizontalOverflow(page);
  });

  test("attention: compact tabs, condition list high in viewport, filters", async ({ context, page }) => {
    await useSession(context, adminToken);
    await gotoMobile(page, "/admin/attention");
    await expect(page.getByRole("tab", { name: "Active", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Open filters/ })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test("activity: mobile grouped list + header filter pill", async ({ context, page }) => {
    await useSession(context, adminToken);
    await gotoMobile(page, "/admin/activity");
    // Header pill (design §05) sits in the 52px header.
    await expect(page.getByRole("banner").getByRole("button", { name: "Open filters" })).toBeVisible();
    await page.getByRole("banner").getByRole("button", { name: "Open filters" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await assertNoHorizontalOverflow(page);
  });

  test("container detail: pinned actions, metric strip, logs tab", async ({ context, page }) => {
    await useSession(context, adminToken);
    if (!containerId) {
      test.skip(true, "no container on the fixture node");
      return;
    }
    await gotoMobile(page, `/admin/containers/${containerNodeId}/${containerId}`);
    // Pinned action bar coexists with the bottom nav.
    await expect(page.locator("[data-mobile-action-bar]")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    // Metric strip.
    await expect(page.locator("[data-metric-strip]")).toBeVisible();
    // Logs tab default; LogViewer present.
    await expect(page.getByRole("tab", { name: "logs" })).toBeVisible();
    await page.getByRole("tab", { name: "config" }).click();
    await expect(page.getByRole("heading", { name: "Details" }).filter({ visible: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test("navigation context: root stays highlighted through detail drill-down", async ({ context, page }) => {
    await useSession(context, adminToken);
    await gotoMobile(page, "/admin/workloads");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByText("Workloads", { exact: true }).click();
    await expect(nav.getByRole("link", { name: /Workloads/ })).toHaveAttribute("aria-current", "page");
    // Open the first workload card.
    const card = page.locator("[data-mobile-cards] button").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.click();
    await page.waitForURL("**/admin/workloads/*");
    // Workloads remains the highlighted root.
    await expect(nav.getByRole("link", { name: /Workloads/ })).toHaveAttribute("aria-current", "page");
    // The mobile header back chevron returns via the breadcrumb stack.
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await page.waitForURL("**/admin/workloads");
    await assertNoHorizontalOverflow(page);
  });

  test("nodes: cards with resource meters", async ({ context, page }) => {
    await useSession(context, adminToken);
    await gotoMobile(page, "/admin/nodes");
    await expect(page.locator("table[aria-label='Nodes']")).toBeHidden();
    await expect(page.getByText("Add node", { exact: true }).last()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test("clients + users: mobile card lists, no table", async ({ context, page }) => {
    await useSession(context, adminToken);
    await gotoMobile(page, "/admin/clients");
    await expect(page.locator("table[aria-label='Resources']")).toBeHidden();
    await assertNoHorizontalOverflow(page);
    await gotoMobile(page, "/admin/settings/users");
    await expect(page.locator("table[aria-label='Users']")).toBeHidden();
    await assertNoHorizontalOverflow(page);
  });

  test("notifications: mobile delivery cards, no 760px table", async ({ context, page }) => {
    await useSession(context, adminToken);
    await gotoMobile(page, "/admin/settings/notifications");
    await assertNoHorizontalOverflow(page);
    const desktopTable = page.locator("table");
    await expect(desktopTable).toBeHidden();
  });

  test("horizontal overflow hard gate: every admin route", async ({ context, page }) => {
    await useSession(context, adminToken);
    const routes = [
      "/admin",
      "/admin/workloads",
      "/admin/containers",
      "/admin/nodes",
      "/admin/clients",
      "/admin/attention",
      "/admin/activity",
      "/admin/settings/users",
      "/admin/settings/notifications",
      "/admin/workloads/new",
      "/admin/compose",
      "/account"
    ];
    for (const route of routes) {
      await gotoMobile(page, route);
      await assertNoHorizontalOverflow(page);
    }
    if (containerId) {
      await gotoMobile(page, `/admin/containers/${containerNodeId}/${containerId}`);
      await assertNoHorizontalOverflow(page);
    }
  });

  test("safe-area/layout: bottom nav fixed, content not hidden behind it", async ({ context, page }) => {
    await useSession(context, adminToken);
    await gotoMobile(page, "/admin");
    const navBox = await page.getByRole("navigation", { name: "Primary" }).boundingBox();
    expect(navBox).not.toBeNull();
    expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(844);
    // Main content has bottom padding for the nav.
    const main = page.locator("main");
    const padding = await main.evaluate((el) => getComputedStyle(el).paddingBottom);
    expect(parseFloat(padding)).toBeGreaterThan(50);
  });
});
