#!/usr/bin/env node
/** Capture the Phase 6F.6 desktop review gate at exactly 1440×900. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  const envFile = path.resolve(process.cwd(), ".env");
  const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const password = /^DB_PASSWORD=(.*)$/m.exec(env)?.[1] ?? "postgres";
  process.env.DATABASE_URL = `postgresql://postgres:${password}@172.24.0.2:5432/hostpanel`;
}

const require = createRequire(`${process.cwd()}/node_modules/`);
const { chromium } = require("playwright");
const BASE = process.env.HOSTPANEL_URL ?? "https://localhost:1337";
const OUT = process.env.SCREEN_DIR ?? path.resolve(process.cwd(), "artifacts/desktop-review-qa");
const VIEWPORT = { width: 1440, height: 900 };
const prisma = new PrismaClient();

fs.mkdirSync(OUT, { recursive: true });

async function capture(page, name, route) {
  await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-page-header]").waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(6500);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: window.innerHeight
  }));
  console.log(`${name.padEnd(30)} ${layout.width}×${layout.height} overflow:${layout.scrollWidth <= layout.width ? "OK" : `FAIL ${layout.scrollWidth}`}`);
}

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
  if (!admin) throw new Error("Desktop capture requires an active admin");
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  await prisma.session.create({ data: { userId: admin.id, tokenHash, expiresAt: new Date(Date.now() + 60 * 60_000) } });

  const node = await prisma.node.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  const workload = await prisma.project.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  const container = await prisma.container.findFirst({ where: { isActive: true, node: { isActive: true } }, orderBy: { dockerName: "asc" }, select: { dockerContainerId: true, nodeId: true } });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  await context.addCookies([{ name: "hostpanel_session", value: token, url: BASE, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();

  await capture(page, "01-overview", "/admin");
  await capture(page, "02-workloads", "/admin/workloads");
  await capture(page, "03-containers", "/admin/containers");
  await capture(page, "04-nodes", "/admin/nodes");
  await capture(page, "05-clients", "/admin/clients");
  await capture(page, "06-attention-all-clear", "/admin/attention");
  await capture(page, "07-activity", "/admin/activity");
  if (container) await capture(page, "08-container-detail", `/admin/containers/${container.nodeId}/${container.dockerContainerId}`);
  if (node) await capture(page, "09-node-detail", `/admin/nodes/${node.id}`);
  if (workload) await capture(page, "10-workload-detail", `/admin/workloads/${workload.id}`);

  await page.goto(`${BASE}/admin/containers`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-desktop-table] tbody tr").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.screenshot({ path: path.join(OUT, "11-sidebar-collapsed.png") });
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await page.screenshot({ path: path.join(OUT, "12-sidebar-expanded.png") });

  const filterBar = page.locator("[data-desktop-filter-bar]");
  await filterBar.getByRole("button", { name: "Add filter" }).click();
  await filterBar.getByRole("button", { name: "State" }).click();
  await filterBar.getByRole("button", { name: "running", exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "13-active-filter-bar.png") });

  await filterBar.getByRole("button", { name: /Remove State filter/ }).click();
  const firstCheckbox = page.locator("[data-desktop-table] tbody").getByRole("checkbox").first();
  await firstCheckbox.check();
  await page.screenshot({ path: path.join(OUT, "14-bulk-selection.png") });

  await capture(page, "15-attention-no-match", "/admin/attention?q=__desktop_review_no_match__");

  if (container) {
    await page.goto(`${BASE}/admin/containers/${container.nodeId}/${container.dockerContainerId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, "16-log-wrap-off.png") });
    await page.getByRole("button", { name: /Wrap off/ }).click();
    await page.screenshot({ path: path.join(OUT, "17-log-wrap-on.png") });
  }

  await browser.close();
  await prisma.session.deleteMany({ where: { tokenHash } });
  await prisma.$disconnect();
  console.log(`Screenshots → ${OUT}`);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
