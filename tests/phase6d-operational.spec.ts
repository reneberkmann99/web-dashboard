import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { encryptSecret } from "@/server/security/crypto";

dotenv.config({ path: ".env" });
const prisma = new PrismaClient();
const baseURL = process.env.HOSTPANEL_URL ?? "http://localhost:1337";
const mockAgentName = `hostpanel-phase6d-mock-${process.pid}`;
const mockNodeName = `Phase 6D Mock Node ${process.pid}`;
const crashContainerName = `hostpanel-phase6d-crash-${process.pid}`;
const crashWorkloadName = `Phase 6D Crash Workload ${process.pid}`;
const degradedWorkloadName = `Phase 6D Degraded Workload ${process.pid}`;

let adminToken = "";
let csrfToken = "";
let adminUserId = "";
let rootNodeId = "";
let mockNodeId = "";
let mockAgentKey = "";
let crashProjectId = "";
let crashContainerId = "";
let crashControlDir = "";
let degradedProjectId = "";
let degradedDeploymentId = "";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("Timed out waiting for controlled Phase 6D fixture state");
}

async function useAdminSession(context: BrowserContext): Promise<void> {
  await context.addCookies([
    { name: "hostpanel_session", value: adminToken, url: baseURL, httpOnly: true, sameSite: "Lax" },
    { name: "hostpanel_csrf", value: csrfToken, url: baseURL, httpOnly: false, sameSite: "Lax" }
  ]);
}

async function refreshOverview(page: Page, settleMs = 0): Promise<void> {
  if (settleMs > 0) await page.waitForTimeout(settleMs);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Needs attention", exact: true })).toBeVisible();
}

async function createManagedDegradedFixture(): Promise<void> {
  const suffix = crypto.randomBytes(5).toString("hex");
  const project = await prisma.project.create({
    data: {
      name: degradedWorkloadName,
      slug: `phase6d-degraded-${suffix}`,
      nodeId: rootNodeId,
      source: "COMPOSE",
      composeProject: `phase6d-degraded-${suffix}`,
      isActive: true
    }
  });
  degradedProjectId = project.id;
  const deployment = await prisma.deployment.create({
    data: { projectId: project.id, composeProjectName: `phase6d-degraded-${suffix}`, runtimeState: "UNKNOWN" }
  });
  degradedDeploymentId = deployment.id;
  const compose = "services:\n  app:\n    image: alpine:3.20\n";
  const [revision1, revision2] = await Promise.all([
    prisma.deploymentRevision.create({
      data: {
        deploymentId: deployment.id,
        revisionNumber: 1,
        composeSource: compose,
        composeCanonical: compose,
        environmentSnapshot: {},
        secretReferences: [],
        contentSha256: crypto.createHash("sha256").update(`${suffix}-1`).digest("hex"),
        analyzerVersion: "phase6d-browser",
        createdById: adminUserId
      }
    }),
    prisma.deploymentRevision.create({
      data: {
        deploymentId: deployment.id,
        revisionNumber: 2,
        composeSource: compose,
        composeCanonical: compose,
        environmentSnapshot: {},
        secretReferences: [],
        contentSha256: crypto.createHash("sha256").update(`${suffix}-2`).digest("hex"),
        analyzerVersion: "phase6d-browser",
        createdById: adminUserId
      }
    })
  ]);
  const healthy = await prisma.deploymentRelease.create({
    data: { deploymentId: deployment.id, revisionId: revision1.id, healthVerdict: "HEALTHY", appliedAt: new Date(), verifiedAt: new Date() }
  });
  const degraded = await prisma.deploymentRelease.create({
    data: { deploymentId: deployment.id, revisionId: revision2.id, healthVerdict: "DEGRADED", appliedAt: new Date(), verifiedAt: new Date() }
  });
  await prisma.deployment.update({
    where: { id: deployment.id },
    data: { currentReleaseId: degraded.id, lastHealthyReleaseId: healthy.id, runtimeState: "DEGRADED" }
  });
}

test.describe.serial("Phase 6D live operational workflows", () => {
  test.beforeAll(async () => {
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
    if (!admin) throw new Error("No active admin user");
    adminUserId = admin.id;
    rootNodeId = process.env.HOSTPANEL_LOG_TEST_NODE_ID ?? "";
    if (!rootNodeId) throw new Error("HOSTPANEL_LOG_TEST_NODE_ID is required");

    adminToken = crypto.randomBytes(32).toString("base64url");
    csrfToken = crypto.randomBytes(24).toString("hex");
    await prisma.session.create({
      data: {
        userId: admin.id,
        tokenHash: crypto.createHash("sha256").update(adminToken).digest("hex"),
        expiresAt: new Date(Date.now() + 2 * 60 * 60_000)
      }
    });

    mockAgentKey = crypto.randomBytes(32).toString("hex");
    execFileSync("docker", [
      "run", "-d", "--name", mockAgentName,
      "--label", "hostpanel.phase6d.fixture=true",
      "--network", "web-dashboard_default",
      "-e", `AGENT_API_KEY=${mockAgentKey}`,
      "-e", "AGENT_DOCKER_MODE=mock",
      "web-dashboard-agent"
    ], { stdio: "ignore" });
    await waitFor(() => {
      try {
        execFileSync("docker", [
          "exec", "web-dashboard-web-1", "node", "-e",
          `fetch('http://${mockAgentName}:8081/containers',{headers:{'x-agent-key':'${mockAgentKey}'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`
        ], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    });
    const node = await prisma.node.create({
      data: {
        name: mockNodeName,
        hostname: `${mockAgentName}.test`,
        apiBaseUrl: `http://${mockAgentName}:8081`,
        apiKeyEncrypted: encryptSecret(mockAgentKey),
        status: "UNKNOWN",
        isActive: true
      }
    });
    mockNodeId = node.id;
    await prisma.container.createMany({
      data: ["acme-web-1", "acme-worker-1", "northstar-api-1"].map((id) => ({
        nodeId: node.id,
        dockerContainerId: id,
        dockerName: id,
        image: "phase6d-mock:latest",
        isActive: true
      }))
    });
  });

  test.afterAll(async () => {
    // Cleanup is deliberately exact and fixture-labelled; never target a
    // workspace, wildcard, volume, network, or unrelated container.
    for (const name of [crashContainerName, mockAgentName]) {
      try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch { /* already absent */ }
    }
    if (crashControlDir && crashControlDir.startsWith(path.join(os.tmpdir(), "hostpanel-phase6d-crash-"))) {
      fs.rmSync(crashControlDir, { recursive: true, force: true });
    }

    if (crashProjectId) {
      await prisma.attentionState.deleteMany({ where: { OR: [{ resourceId: crashProjectId }, { resourceId: { contains: crashContainerId } }] } });
      await prisma.containerRestartSample.deleteMany({ where: { nodeId: rootNodeId, dockerContainerId: crashContainerId } });
      await prisma.container.deleteMany({ where: { projectId: crashProjectId } });
      await prisma.project.deleteMany({ where: { id: crashProjectId } });
    }
    if (degradedDeploymentId) {
      await prisma.attentionState.deleteMany({ where: { resourceId: degradedProjectId } });
      await prisma.deploymentRelease.deleteMany({ where: { deploymentId: degradedDeploymentId } });
      await prisma.deploymentRevision.deleteMany({ where: { deploymentId: degradedDeploymentId } });
      await prisma.deployment.deleteMany({ where: { id: degradedDeploymentId } });
      await prisma.project.deleteMany({ where: { id: degradedProjectId } });
    }
    if (mockNodeId) {
      await prisma.attentionState.deleteMany({ where: { OR: [{ resourceId: mockNodeId }, { metadata: { path: ["nodeId"], equals: mockNodeId } }] } });
      await prisma.containerRestartSample.deleteMany({ where: { nodeId: mockNodeId } });
      await prisma.nodeResourceSample.deleteMany({ where: { nodeId: mockNodeId } });
      await prisma.container.deleteMany({ where: { nodeId: mockNodeId } });
      await prisma.node.deleteMany({ where: { id: mockNodeId } });
    }
    const hash = crypto.createHash("sha256").update(adminToken).digest("hex");
    await prisma.session.deleteMany({ where: { tokenHash: hash } });
    await prisma.$disconnect();
  });

  test("healthy controlled node stays quiet", async ({ context, page }) => {
    await useAdminSession(context);
    await refreshOverview(page);
    await expect(page.getByRole("link", { name: new RegExp(`${mockNodeName} online 3 containers`) })).toBeVisible();
    await expect(page.getByText(`${mockNodeName} is offline`, { exact: true })).toHaveCount(0);
    await expect(page.getByText(`${mockNodeName} heartbeat is stale`, { exact: true })).toHaveCount(0);
  });

  test("node failure groups affected containers and resolves on recovery", async ({ context, page }) => {
    await useAdminSession(context);
    execFileSync("docker", ["stop", mockAgentName], { stdio: "ignore" });
    await prisma.node.update({
      where: { id: mockNodeId },
      data: { status: "ONLINE", lastHeartbeatAt: new Date(Date.now() - 6 * 60_000) }
    });
    await refreshOverview(page, 16_000);
    const issue = page.getByRole("button", { name: new RegExp(`${mockNodeName} is offline`) });
    await expect(issue).toBeVisible({ timeout: 30_000 });
    await expect(issue).toContainText(/3 containers affected/);
    await expect(page.getByText(/acme-web.*unavailable/i)).toHaveCount(0);

    execFileSync("docker", ["start", mockAgentName], { stdio: "ignore" });
    await refreshOverview(page, 16_000);
    await expect(page.getByText(`${mockNodeName} is offline`, { exact: true })).toHaveCount(0);
  });

  test("unhealthy container links directly to detail/logs and resolves", async ({ context, page }) => {
    const logContainerId = process.env.HOSTPANEL_LOG_TEST_CONTAINER_ID;
    test.skip(!logContainerId, "Controlled health/log fixture not supplied");
    await useAdminSession(context);

    // Remove only the disposable fixture's health marker.
    execFileSync("docker", ["exec", logContainerId!, "rm", "-f", "/tmp/healthy"], { stdio: "ignore" });
    await waitFor(() => execFileSync("docker", ["inspect", "-f", "{{.State.Health.Status}}", logContainerId!], { encoding: "utf8" }).trim() === "unhealthy");
    await refreshOverview(page, 16_000);
    const issue = page.getByRole("button", { name: /hostpanel-phase6d-log is unhealthy/i });
    await expect(issue).toBeVisible({ timeout: 30_000 });
    await issue.click();
    await expect(page).toHaveURL(new RegExp(`/admin/containers/${rootNodeId}/${logContainerId}`));
    await expect(page.getByRole("heading", { name: "Logs" })).toBeVisible();

    execFileSync("docker", ["exec", logContainerId!, "touch", "/tmp/healthy"], { stdio: "ignore" });
    await waitFor(() => execFileSync("docker", ["inspect", "-f", "{{.State.Health.Status}}", logContainerId!], { encoding: "utf8" }).trim() === "healthy");
    await refreshOverview(page, 16_000);
    await expect(page.getByText("hostpanel-phase6d-log is unhealthy", { exact: true })).toHaveCount(0);
  });

  test("crash-loop appears only after threshold and clears after recovery window", async ({ context, page }) => {
    test.setTimeout(180_000);
    await useAdminSession(context);
    crashControlDir = fs.mkdtempSync(path.join(os.tmpdir(), "hostpanel-phase6d-crash-"));
    fs.writeFileSync(path.join(crashControlDir, "run"), "running\n", { mode: 0o600 });
    execFileSync("docker", [
      "run", "-d", "--name", crashContainerName,
      "--label", "hostpanel.phase6d.fixture=true",
      "--restart", "always",
      "-v", `${crashControlDir}:/control:ro`,
      "alpine:3.20", "sh", "-c", "while [ -f /control/run ]; do sleep 1; done; exit 1"
    ], { stdio: "ignore" });
    crashContainerId = execFileSync("docker", ["ps", "--filter", `name=^/${crashContainerName}$`, "--format", "{{.ID}}"], { encoding: "utf8" }).trim();
    const project = await prisma.project.create({
      data: { name: crashWorkloadName, slug: `phase6d-crash-${process.pid}`, nodeId: rootNodeId, source: "MANUAL", isActive: true }
    });
    crashProjectId = project.id;
    await prisma.container.create({
      data: {
        nodeId: rootNodeId,
        dockerContainerId: crashContainerId,
        dockerName: crashContainerName,
        image: "alpine:3.20",
        projectId: project.id,
        isActive: true
      }
    });

    // Baseline at restart count zero must not alert.
    await refreshOverview(page, 16_000);
    await expect(page.getByText(`${crashWorkloadName} requires attention`, { exact: true })).toHaveCount(0);

    fs.unlinkSync(path.join(crashControlDir, "run"));
    await waitFor(() => Number(execFileSync("docker", ["inspect", "-f", "{{.RestartCount}}", crashContainerName], { encoding: "utf8" }).trim()) >= 8, 45_000);
    await refreshOverview(page, 16_000);
    const crashIssue = page.getByRole("button", { name: new RegExp(crashWorkloadName) });
    await expect(crashIssue).toBeVisible({ timeout: 30_000 });
    await expect(crashIssue).toContainText("crash-looping");

    fs.writeFileSync(path.join(crashControlDir, "run"), "running\n", { mode: 0o600 });
    await waitFor(() => execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", crashContainerName], { encoding: "utf8" }).trim() === "true");
    await prisma.containerRestartSample.updateMany({
      where: { nodeId: rootNodeId, dockerContainerId: crashContainerId },
      data: { observedAt: new Date(Date.now() - 11 * 60_000) }
    });
    await refreshOverview(page, 16_000);
    await expect(page.getByText(`${crashWorkloadName} requires attention`, { exact: true })).toHaveCount(0);
  });

  test("managed DEGRADED stays degraded, shows releases, and never becomes DRIFTED", async ({ context, page }) => {
    await useAdminSession(context);
    await createManagedDegradedFixture();
    await refreshOverview(page, 16_000);
    const issue = page.getByRole("button", { name: new RegExp(`${degradedWorkloadName} deployment is degraded`) });
    await expect(issue).toBeVisible({ timeout: 30_000 });
    await expect(issue).not.toContainText("DRIFTED");
    await issue.click();
    await expect(page.getByRole("heading", { name: "Managed deployment" })).toBeVisible();
    await expect(page.getByText("Degraded", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Last healthy/i).first()).toBeVisible();
    await expect(page.getByText("Release #1 · Revision 1", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "View deployment" })).toBeVisible();
  });

  test("controlled failed operation appears in Recent failures", async ({ context, page }) => {
    await useAdminSession(context);
    const missingId = `phase6d-missing-${process.pid}`;
    const response = await page.request.post(`/api/admin/containers/direct/${mockNodeId}/${missingId}`, {
      headers: { "x-csrf-token": csrfToken },
      data: { action: "restart" }
    });
    expect(response.status()).toBe(202);
    const payload = await response.json() as { ok: true; data: { operationId: string } };
    await waitFor(async () => {
      const operation = await prisma.operation.findUnique({ where: { id: payload.data.operationId }, select: { state: true } });
      return operation?.state === "FAILED";
    });
    await refreshOverview(page, 16_000);
    await expect(page.getByRole("heading", { name: "Recent failures" })).toBeVisible();
    await expect(page.getByText(new RegExp(`restart failed on ${mockNodeName}`, "i"))).toBeVisible();
  });
});
