/* Production visual-QA screenshot capture (Phase 6G design gate §36).
 *
 * Logs in as a real ADMIN via the same DB-session mechanism the browser
 * regression specs use, then captures the pages listed in the gate against
 * the deployed production control plane. Screenshots land in
 * artifacts/noderaft-design/qa-screenshots/.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/qa-screenshots.mjs
 */
import { chromium } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config({ path: ".env" });
const prisma = new PrismaClient();
const baseURL = process.env.QA_BASE_URL ?? "https://localhost:1337";
const outDir = path.resolve(process.env.QA_OUT_DIR ?? "artifacts/noderaft-design/qa-screenshots");
fs.mkdirSync(outDir, { recursive: true });

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
  if (!admin) throw new Error("requires an active ADMIN user");
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      userId: admin.id,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60_000)
    }
  });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await context.addCookies([{ name: "hostpanel_session", value: token, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();

  const shots = [
    ["01-login", "/login"],
    ["02-overview", "/admin"],
    ["03-workloads", "/admin/workloads"],
    ["04-containers", "/admin/containers"],
    ["05-nodes", "/admin/nodes"],
    ["06-clients", "/admin/clients"],
    ["07-attention", "/admin/attention"],
    ["08-activity", "/admin/activity"],
    ["09-users", "/admin/settings/users"],
    ["10-notifications", "/admin/settings/notifications"]
  ];

  for (const [name, route] of shots) {
    try {
      await page.goto(`${baseURL}${route}`, { waitUntil: "networkidle", timeout: 45_000 });
      await page.waitForTimeout(2500);
      await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
      console.log(`ok ${name}`);
    } catch (err) {
      console.log(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Detail pages — resolve real ids from the DB.
  const node = await prisma.node.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  const workload = await prisma.project.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  const container = await prisma.container.findFirst({ where: { isActive: true }, orderBy: { dockerName: "asc" }, select: { id: true, dockerContainerId: true, nodeId: true } });
  const client = await prisma.clientAccount.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });

  const detailShots = [];
  if (node) {
    detailShots.push(
      ["11-node-overview", `/admin/nodes/${node.id}`],
      ["12-node-workloads", `/admin/nodes/${node.id}?tab=workloads`],
      ["13-node-containers", `/admin/nodes/${node.id}?tab=containers`],
      ["14-node-configuration", `/admin/nodes/${node.id}?tab=configuration`],
      ["15-node-activity", `/admin/nodes/${node.id}?tab=activity`]
    );
  }
  if (workload) detailShots.push(["16-workload-overview", `/admin/workloads/${workload.id}`]);
  if (container) detailShots.push(["17-container-detail", `/admin/containers/${container.nodeId}/${container.dockerContainerId}`]);
  if (client) detailShots.push(["18-client-detail", `/admin/clients/${client.id}`]);

  for (const [name, route] of detailShots) {
    try {
      await page.goto(`${baseURL}${route}`, { waitUntil: "networkidle", timeout: 45_000 });
      await page.waitForTimeout(2500);
      await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
      console.log(`ok ${name}`);
    } catch (err) {
      console.log(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  await prisma.session.deleteMany({ where: { tokenHash: crypto.createHash("sha256").update(token).digest("hex") } });
  await browser.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
