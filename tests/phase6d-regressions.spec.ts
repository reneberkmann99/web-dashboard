import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config({ path: ".env" });
const prisma = new PrismaClient();
const baseURL = process.env.HOSTPANEL_URL ?? "http://localhost:1337";

let adminToken = "";
let clientToken = "";
let nodeId = "";
let clientId = "";
let adminWorkloadId = "";
let clientWorkloadId = "";

async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      userId,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60_000)
    }
  });
  return token;
}

async function useSession(context: BrowserContext, token: string): Promise<void> {
  await context.addCookies([{ name: "hostpanel_session", value: token, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}

async function assertStableTabs(page: Page, tabs: string[]): Promise<void> {
  const tablist = page.getByRole("tablist", { name: "Sections" });
  await expect(tablist).toBeVisible({ timeout: 30_000 });
  const baseline = await tablist.boundingBox();
  expect(baseline).not.toBeNull();
  for (const tab of tabs) {
    const button = page.getByRole("tab", { name: tab, exact: true });
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toHaveAttribute("aria-selected", "true");
    const current = await tablist.boundingBox();
    expect(current).not.toBeNull();
    expect(Math.abs(current!.y - baseline!.y)).toBeLessThan(1);
  }
}

test.beforeAll(async () => {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
  if (!admin) throw new Error("Phase 6D browser regression requires one active admin user");
  const node = await prisma.node.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  const client = await prisma.clientAccount.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  const workload =
    (await prisma.project.findFirst({ where: { isActive: true, deployment: { isNot: null } }, orderBy: { name: "asc" }, select: { id: true } }))
    ?? (await prisma.project.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } }));
  if (!node || !client || !workload) throw new Error("Phase 6D browser regression requires a node, client, and workload");

  const clientUser = await prisma.user.findFirst({
    where: {
      isActive: true,
      role: { in: ["CLIENT", "CLIENT_ADMIN", "CLIENT_OPERATOR", "CLIENT_VIEWER"] },
      clientAccountId: { not: null }
    },
    select: {
      id: true,
      clientAccountId: true,
      clientAccount: {
        select: { grants: { where: { isActive: true, projectId: { not: null } }, take: 1, select: { projectId: true } } }
      }
    }
  });

  adminToken = await createSession(admin.id);
  nodeId = node.id;
  clientId = client.id;
  adminWorkloadId = workload.id;
  const ownedClientProject = clientUser?.clientAccountId
    ? await prisma.project.findFirst({ where: { isActive: true, clientAccountId: clientUser.clientAccountId }, select: { id: true } })
    : null;
  const visibleClientProjectId = ownedClientProject?.id ?? clientUser?.clientAccount?.grants[0]?.projectId;
  if (clientUser && visibleClientProjectId) {
    clientToken = await createSession(clientUser.id);
    clientWorkloadId = visibleClientProjectId;
  }
});

test.afterAll(async () => {
  const hashes = [adminToken, clientToken]
    .filter(Boolean)
    .map((token) => crypto.createHash("sha256").update(token).digest("hex"));
  if (hashes.length > 0) await prisma.session.deleteMany({ where: { tokenHash: { in: hashes } } });
  await prisma.$disconnect();
});

test("node detail tab bar remains structurally fixed", async ({ context, page }) => {
  await useSession(context, adminToken);
  await page.goto(`/admin/nodes/${nodeId}`);
  await assertStableTabs(page, ["Overview", "Workloads", "Containers", "Configuration", "Activity"]);
});

test("client detail tab bar remains structurally fixed", async ({ context, page }) => {
  await useSession(context, adminToken);
  await page.goto(`/admin/clients/${clientId}`);
  await assertStableTabs(page, ["Overview", "Users", "Workloads", "Permissions", "Deployment Nodes", "Activity"]);
});

test("admin workload detail tab bar remains structurally fixed", async ({ context, page }) => {
  await useSession(context, adminToken);
  await page.goto(`/admin/workloads/${adminWorkloadId}`);
  const visibleTabs = await page.getByRole("tablist", { name: "Sections" }).getByRole("tab").allTextContents();
  await assertStableTabs(page, visibleTabs);
});

test("client workload detail tab bar remains structurally fixed", async ({ context, page }) => {
  test.skip(!clientToken || !clientWorkloadId, "No active client user with a project grant is available");
  await useSession(context, clientToken);
  await page.goto(`/client/workloads/${clientWorkloadId}`);
  const visibleTabs = await page.getByRole("tablist", { name: "Sections" }).getByRole("tab").allTextContents();
  await assertStableTabs(page, visibleTabs);
});

test("LogViewer stays connected across parent polls and pause/resume does not duplicate lines", async ({ context, page }) => {
  const logNodeId = process.env.HOSTPANEL_LOG_TEST_NODE_ID;
  const logContainerId = process.env.HOSTPANEL_LOG_TEST_CONTAINER_ID;
  test.skip(!logNodeId || !logContainerId, "Controlled continuous-log fixture not supplied");
  await useSession(context, adminToken);

  let streamRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes(`/containers/direct/${logNodeId}/${logContainerId}/logs/stream`)) streamRequests += 1;
  });

  await page.goto(`/admin/containers/${logNodeId}/${logContainerId}`);
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });
  const logView = page.locator("pre.log-scroll");
  await expect(logView).toBeVisible();

  // The parent detail query polls every 8s. Two cycles must not restart SSE.
  await page.waitForTimeout(17_000);
  expect(streamRequests).toBe(1);

  await page.getByRole("button", { name: /pause/i }).click();
  const pausedText = await logView.textContent();
  await page.waitForTimeout(2_500);
  expect(await logView.textContent()).toBe(pausedText);
  await page.getByRole("button", { name: /resume/i }).click();
  await page.waitForTimeout(2_500);

  const lines = (await logView.innerText()).split("\n").filter(Boolean);
  expect(new Set(lines).size).toBe(lines.length);
  expect(streamRequests).toBe(1);
});

test("LogViewer reconnect replaces its tail after a controlled stream interruption", async ({ context, page }) => {
  const logNodeId = process.env.HOSTPANEL_LOG_TEST_NODE_ID;
  const logContainerId = process.env.HOSTPANEL_LOG_TEST_CONTAINER_ID;
  test.skip(!logNodeId || !logContainerId || process.env.HOSTPANEL_LOG_TEST_MANAGE !== "1", "Managed log fixture not supplied");
  await useSession(context, adminToken);

  let streamRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes(`/containers/direct/${logNodeId}/${logContainerId}/logs/stream`)) streamRequests += 1;
  });
  await page.goto(`/admin/containers/${logNodeId}/${logContainerId}`);
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });
  const logView = page.locator("pre.log-scroll");

  try {
    execFileSync("docker", ["stop", logContainerId!], { stdio: "ignore" });
    await expect(page.getByText("Disconnected", { exact: true })).toBeVisible({ timeout: 15_000 });
    execFileSync("docker", ["start", logContainerId!], { stdio: "ignore" });
    await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(3_000);
    expect(streamRequests).toBeGreaterThan(1);
    const lines = (await logView.innerText()).split("\n").filter(Boolean);
    expect(new Set(lines).size).toBe(lines.length);
  } finally {
    const running = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", logContainerId!], { encoding: "utf8" }).trim();
    if (running !== "true") execFileSync("docker", ["start", logContainerId!], { stdio: "ignore" });
  }
});
