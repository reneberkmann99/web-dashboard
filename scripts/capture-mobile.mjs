#!/usr/bin/env node
/**
 * Capture Noderaft mobile QA screenshots at the design reference viewport
 * 390×844 for the seven supplied design screens plus the derived screens.
 *
 * Usage: node scripts/capture-mobile.mjs
 * Env: HOSTPANEL_URL (default http://localhost:1337), SCREEN_DIR
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

// Browser suites talk to the LIVE control plane, so the Prisma client must
// point at the production hostpanel database (never the vitest test DB).
if (!process.env.DATABASE_URL) {
  const envFile = path.resolve(process.cwd(), ".env");
  const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const password = /^DB_PASSWORD=(.*)$/m.exec(env)?.[1] ?? "postgres";
  process.env.DATABASE_URL = `postgresql://postgres:${password}@172.24.0.2:5432/hostpanel`;
}

const require = createRequire(process.cwd() + "/node_modules/");
const { chromium } = require("playwright");

const BASE = process.env.HOSTPANEL_URL ?? "https://localhost:1337";
const SCREEN_DIR = process.env.SCREEN_DIR ?? "/home/rene/.openclaw/workspace/artifacts/noderaft-mobile-design/qa";
const VIEWPORT = { width: 390, height: 844 };

const prisma = new PrismaClient();
fs.mkdirSync(SCREEN_DIR, { recursive: true });

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } });
  if (!admin) throw new Error("capture-mobile requires an active admin user");
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      userId: admin.id,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60_000)
    }
  });

  const node = await prisma.node.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  const container = node
    ? await prisma.container.findFirst({ where: { nodeId: node.id }, orderBy: { name: "asc" }, select: { id: true, nodeId: true } })
    : null;
  const workload = await prisma.project.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  const client = await prisma.clientAccount.findFirst({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true } });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  await context.addCookies([{ name: "hostpanel_session", value: token, url: BASE, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();

  const shots = [
    ["01-overview", "/admin"],
    ["02-containers", "/admin/containers"],
    ["03-workloads", "/admin/workloads"],
    ["04-attention", "/admin/attention"],
    ["05-activity", "/admin/activity"],
    ["06-nodes", "/admin/nodes"],
    ["07-clients", "/admin/clients"],
    ["08-users", "/admin/settings/users"],
    ["09-notifications", "/admin/settings/notifications"],
    ...(workload ? [["10-workload-detail", `/admin/workloads/${workload.id}`]] : []),
    ...(node ? [["11-node-detail", `/admin/nodes/${node.id}`]] : []),
    ...(container ? [["12-container-detail", `/admin/containers/${container.nodeId}/${container.id}`]] : []),
    ...(client ? [["13-client-detail", `/admin/clients/${client.id}`]] : [])
  ];

  for (const [name, path] of shots) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    // Full-page capture (mobile scroll) — the design reference is one screen,
    // but a full capture shows the complete page structure; the 844px top
    // section is the pixel-level comparison target.
    const file = `${SCREEN_DIR}/${name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    console.log(`${name.padEnd(22)} ${file}  overflow:${overflow.scrollWidth <= overflow.clientWidth ? "OK" : `FAIL ${JSON.stringify(overflow)}`}`);
  }

  // Filter sheet (open state) + account sheet (open state).
  await page.goto(`${BASE}/admin/containers`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Open filters/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREEN_DIR}/14-filter-sheet.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Open account sheet" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREEN_DIR}/15-account-sheet.png` });

  await browser.close();
  await prisma.$disconnect();
  console.log(`Screenshots → ${SCREEN_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
