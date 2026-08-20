import { expect, test, type BrowserContext } from "@playwright/test";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/server/auth/password";

dotenv.config({ path: ".env" });
const prisma = new PrismaClient();
const baseURL = process.env.HOSTPANEL_URL ?? "https://10.99.2.1:1337";
const suffix = crypto.randomBytes(5).toString("hex");
const title = `Phase 6E controlled unhealthy service ${suffix}`;
const browserAdminEmail = `phase6e-browser-${suffix}@hostpanel.test`;
const browserAdminPassword = `Phase6E-${crypto.randomBytes(12).toString("base64url")}!`;

let adminUserId = "";
let adminToken = "";
let csrfToken = "";
let conditionId = "";
let nodeId = "";

async function useAdminSession(context: BrowserContext): Promise<void> {
  const secure = baseURL.startsWith("https://");
  await context.addCookies([
    { name: "hostpanel_session", value: adminToken, url: baseURL, httpOnly: true, secure, sameSite: "Lax" },
    { name: "hostpanel_csrf", value: csrfToken, url: baseURL, httpOnly: false, secure, sameSite: "Lax" }
  ]);
}

test.describe.serial("Phase 6E attention lifecycle UI", () => {
  test.beforeAll(async () => {
    const node = await prisma.node.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
    if (!node) throw new Error("Phase 6E browser qualification requires an active node");
    const admin = await prisma.user.create({
      data: {
        email: browserAdminEmail,
        displayName: "Phase 6E Browser Admin",
        passwordHash: await hashPassword(browserAdminPassword),
        role: "ADMIN",
        isActive: true
      },
      select: { id: true }
    });
    adminUserId = admin.id;
    nodeId = node.id;
    adminToken = crypto.randomBytes(32).toString("base64url");
    csrfToken = crypto.randomBytes(24).toString("hex");
    await prisma.session.create({
      data: {
        userId: admin.id,
        tokenHash: crypto.createHash("sha256").update(adminToken).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60_000)
      }
    });
    const condition = await prisma.attentionState.create({
      data: {
        resourceType: "CONTAINER",
        resourceId: `${node.id}:phase6e-browser-${suffix}`,
        conditionType: "CONTAINER_UNHEALTHY",
        severity: "WARNING",
        title,
        detail: "Controlled browser qualification healthcheck failure",
        metadata: { nodeId: node.id, phase6eBrowserFixture: suffix }
      }
    });
    conditionId = condition.id;
  });

  test.afterAll(async () => {
    if (conditionId) {
      await prisma.attentionSilence.deleteMany({ where: { attentionStateId: conditionId } });
      await prisma.attentionAcknowledgement.deleteMany({ where: { attentionStateId: conditionId } });
      await prisma.attentionState.deleteMany({ where: { id: conditionId } });
    }
    await prisma.maintenanceWindow.deleteMany({ where: { reason: `Phase 6E browser ${suffix}` } });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { targetId: conditionId || "__none__" },
          { metadata: { path: ["reason"], equals: `Phase 6E browser ${suffix}` } }
        ]
      }
    });
    if (adminToken) {
      await prisma.session.deleteMany({
        where: { tokenHash: crypto.createHash("sha256").update(adminToken).digest("hex") }
      });
    }
    if (adminUserId) await prisma.user.deleteMany({ where: { id: adminUserId } });
    await prisma.$disconnect();
  });

  test("login, secure session persistence, navigation and logout work over HTTPS", async ({ context, page }) => {
    const insecureBrowserRequests: string[] = [];
    const mixedContentErrors: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith("http://")) insecureBrowserRequests.push(request.url());
    });
    page.on("console", (message) => {
      if (/mixed content/i.test(message.text())) mixedContentErrors.push(message.text());
    });
    await page.goto("/login");
    await page.getByLabel("Email or Linux username").fill(browserAdminEmail);
    await page.getByLabel("Password").fill(browserAdminPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === "hostpanel_session");
    expect(sessionCookie?.secure).toBe(true);
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe("Lax");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "Attention", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Attention", exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Logout" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Email or Linux username").fill(browserAdminEmail);
    await page.getByLabel("Password").fill(browserAdminPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.getByRole("button", { name: "Logout" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(insecureBrowserRequests).toEqual([]);
    expect(mixedContentErrors).toEqual([]);
  });

  test("acknowledgement and silence remain separate from operational health", async ({ context, page }) => {
    // The preceding Overview qualification legitimately runs the live
    // attention sync, which resolves any condition not backed by telemetry.
    // Re-open this explicitly controlled fixture before testing operator
    // lifecycle actions; the Attention Center itself is a read path.
    await prisma.attentionState.update({
      where: { id: conditionId },
      data: { resolvedAt: null, firstObservedAt: new Date(), lastObservedAt: new Date() }
    });
    await useAdminSession(context);
    await page.goto(`/admin/attention?conditionId=${conditionId}`);
    await expect(page.getByRole("heading", { name: "Attention", exact: true })).toBeVisible({ timeout: 30_000 });

    const detail = page.getByRole("dialog", { name: title });
    await expect(detail).toBeVisible();
    await detail.getByRole("button", { name: "Acknowledge", exact: true }).click();
    const acknowledgement = page.getByRole("dialog", { name: "Acknowledge issue" });
    await acknowledgement.getByPlaceholder("Investigating upstream DNS issue").fill("Phase 6E browser investigation");
    await acknowledgement.getByRole("button", { name: "Acknowledge", exact: true }).click();
    await expect(detail.getByText(/Acknowledged by/)).toBeVisible();

    const activeAfterAck = await prisma.attentionState.findUniqueOrThrow({ where: { id: conditionId } });
    expect(activeAfterAck.resolvedAt).toBeNull();
    expect(activeAfterAck.severity).toBe("WARNING");

    await detail.getByRole("button", { name: "Silence", exact: true }).click();
    const silence = page.getByRole("dialog", { name: "Silence notifications" });
    await silence.getByLabel("Reason (optional)").fill("Phase 6E browser silence");
    await silence.getByRole("button", { name: "Silence", exact: true }).click();
    await expect(detail.getByText(/Notifications silenced until/)).toBeVisible();

    const activeAfterSilence = await prisma.attentionState.findUniqueOrThrow({ where: { id: conditionId } });
    expect(activeAfterSilence.resolvedAt).toBeNull();
  });

  test("maintenance metadata does not mutate the node or condition", async ({ context, page }) => {
    await useAdminSession(context);
    await page.goto("/admin/attention");
    await page.getByRole("button", { name: "Schedule maintenance" }).click();
    const dialog = page.getByRole("dialog", { name: "Schedule maintenance" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Resource type", exact: true }).selectOption("NODE");
    await dialog.getByRole("combobox", { name: "Resource", exact: true }).selectOption(nodeId);
    await dialog.getByRole("textbox", { name: "Reason", exact: true }).fill(`Phase 6E browser ${suffix}`);
    await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(page.getByText("Maintenance scheduled", { exact: true })).toBeVisible();
    await expect(page.getByText(`Phase 6E browser ${suffix}`, { exact: false })).toBeVisible();

    const [condition, node, maintenance] = await Promise.all([
      prisma.attentionState.findUniqueOrThrow({ where: { id: conditionId } }),
      prisma.node.findUniqueOrThrow({ where: { id: nodeId } }),
      prisma.maintenanceWindow.findFirstOrThrow({ where: { nodeId, reason: `Phase 6E browser ${suffix}` } })
    ]);
    expect(condition.resolvedAt).toBeNull();
    expect(node.isActive).toBe(true);
    expect(maintenance.notificationBehavior).toBe("SUPPRESS");
  });
});
