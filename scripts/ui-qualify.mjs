#!/usr/bin/env node
/**
 * Phase 6C browser qualification (Playwright).
 *
 * Drives the REAL admin UI end-to-end against a disposable managed fixture:
 *   overview card → deployments tab → editor (validate/save/diff/plan/deploy)
 *   → secret rotation → stale-plan recovery → degraded result UX → rollback.
 *
 * Prerequisite: a fixture with a first deploy exists (run
 * `node scripts/e2e-managed.mjs first-deploy` first) and the state file is at
 * /tmp/hostpanel-e2e-managed-state.json.
 *
 * Screenshots land in SCREEN_DIR. No plaintext secrets are asserted to be
 * visible anywhere in the DOM after each flow.
 *
 * Usage: node scripts/ui-qualify.mjs
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire("/tmp/pw/");
const { chromium } = require("playwright");

const BASE = process.env.HOSTPANEL_URL ?? "http://localhost:1337";
const SCREEN_DIR = process.env.SCREEN_DIR ?? "/home/rene/.openclaw/workspace/artifacts/hostpanel-6c-screens";
const STATE_PATH = "/tmp/hostpanel-e2e-managed-state.json";

fs.mkdirSync(SCREEN_DIR, { recursive: true });

function readEnvFile() {
  const env = {};
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return env;
}
const envFile = readEnvFile();

const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
if (!state.projectId || !state.deploymentId) throw new Error("fixture state missing — run first-deploy first");

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures += 1;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

let shotN = 0;
async function shot(page, name) {
  shotN += 1;
  const path = `${SCREEN_DIR}/${String(shotN).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log(`  📷 ${path}`);
}

async function bodyText(page) {
  // innerText reflects CSS text-transform (e.g. uppercase labels); normalize
  // so assertions stay stable regardless of label styling.
  const t = await page.evaluate(() => document.body.innerText);
  return t.toLowerCase();
}

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.fill("#email", envFile.SEED_ADMIN_EMAIL);
  await page.fill("#password", envFile.SEED_ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/admin/, { timeout: 15000 });
}

async function openTab(page, workloadId, tabName) {
  await page.goto(`${BASE}/admin/workloads/${workloadId}`);
  await page.getByRole("tab", { name: tabName }).click();
}

async function waitForText(page, text, timeout = 90000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });
}

/** Replace the editor textarea value through React's native value setter so
 * onChange fires and component state actually updates. */
async function setEditorValue(page, replacerSource, arg) {
  // The transform travels as the pageFunction itself (Playwright supports
  // functions there), with the marker passed as a serializable argument.
  return page.evaluate(replacerSource, arg);
}

const MARKER_REV = crypto.randomBytes(4).toString("hex");
const ROTATE_VALUES = [crypto.randomBytes(12).toString("hex"), crypto.randomBytes(12).toString("hex")];

async function main() {
  const workloadId = state.projectId;
  const deploymentId = state.deploymentId;

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/home/rene/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    args: ["--no-sandbox"]
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(30000);

  console.log("== login + overview (managed deployment card) ==");
  await login(page);
  await page.goto(`${BASE}/admin/workloads/${workloadId}`);
  await waitForText(page, "Managed deployment");
  await shot(page, "overview-managed-card-healthy");
  let text = await bodyText(page);
  check(text.includes("runtime converged"), "overview shows runtime state");
  check(text.includes("release"), "overview shows release");
  check(!text.includes("degraded"), "healthy workload not shown as degraded");

  console.log("== deployments tab + release history ==");
  await openTab(page, workloadId, "Deployments");
  await waitForText(page, "Current state");
  await shot(page, "deployments-tab");
  text = await bodyText(page);
  check(text.includes("current"), "release history marks CURRENT");
  check(text.includes("last healthy"), "release history marks LAST HEALTHY");
  check(text.includes("healthy"), "release history shows HEALTHY");

  // Release detail modal.
  await page.getByText("Release 1", { exact: false }).first().click();
  await waitForText(page, "Runtime image identities");
  await shot(page, "release-detail");
  check((await bodyText(page)).includes("observed, not tags"), "release detail explains runtime image identity source");
  await page.getByLabel("Close").click();

  console.log("== editor: healthy revision update (UI) ==");
  await page.goto(`${BASE}/admin/workloads/${workloadId}/deployment/edit`);
  await page.waitForSelector("textarea", { state: "visible" });
  await page.waitForFunction(() => {
    const t = document.querySelector("textarea");
    return t && t.value.includes("APP_SECRET");
  }, null, { timeout: 20000 });
  const newCompose = await setEditorValue(
    page,
    (marker) => {
      const t = document.querySelector("textarea");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      const next = t.value.replace("APP_SECRET: ${APP_SECRET}", "APP_SECRET: ${APP_SECRET}\n      UI_MARKER: " + marker);
      setter.call(t, next);
      t.dispatchEvent(new Event("input", { bubbles: true }));
      return next;
    },
    MARKER_REV
  );
  check(newCompose.includes(`UI_MARKER: ${MARKER_REV}`), "editor content changed");

  await page.getByRole("button", { name: "Validate" }).click();
  await waitForText(page, "Validation", 30000);
  await shot(page, "editor-validate");
  await page.getByRole("button", { name: /Save as new revision/i }).click();
  await waitForText(page, "Saved as revision", 30000);
  await waitForText(page, "Changes vs revision");
  await shot(page, "editor-diff");
  check((await bodyText(page)).includes(`ui_marker: ${MARKER_REV}`), "diff shows the added line");

  await page.getByRole("button", { name: /Generate deployment plan/i }).click();
  await waitForText(page, "HostPanel will NOT");
  await shot(page, "plan-view");
  text = await bodyText(page);
  check(text.includes("keep"), "plan shows persistent resources as KEEP");
  check(text.includes("hostpanel will not"), "plan states non-destructive guarantees");
  check(text.includes("docker compose down"), "plan mentions no down");

  await page.getByRole("button", { name: /Deploy revision/i }).click();
  await waitForText(page, "Deployment completed successfully", 120000);
  await shot(page, "editor-deploy-success");
  await page.getByRole("button", { name: /Back to workload/i }).click();
  await page.waitForURL(/\/admin\/workloads\/\w+$/);
  await openTab(page, workloadId, "Deployments");
  await waitForText(page, "Release 2", 30000);
  check((await bodyText(page)).includes("release 2"), "release history shows release 2 after UI deploy");

  console.log("== secrets tab: rotation (UI) ==");
  await openTab(page, workloadId, "Secrets");
  await waitForText(page, "APP_SECRET");
  await shot(page, "secrets-tab");
  await page.getByRole("button", { name: "Rotate", exact: true }).first().click();
  await waitForText(page, "Enter the new value");
  await page.fill('input[type="password"]', ROTATE_VALUES[0]);
  await shot(page, "rotate-input");
  await page.getByRole("dialog").getByRole("button", { name: "Rotate", exact: true }).click();
  await waitForText(page, "reconcile", 30000);
  await shot(page, "rotate-plan");
  await page.getByRole("button", { name: /Deploy to reconcile/i }).click();
  await waitForText(page, "Secret rotated successfully", 120000);
  await shot(page, "rotate-success");
  text = await bodyText(page);
  check(text.includes("configuration remains the same revision"), "rotation result says revision unchanged");
  check(text.includes("a new release was created"), "rotation result says new release created");
  check(!text.includes(ROTATE_VALUES[0]), "rotated plaintext not visible in DOM after submission");
  await page.getByLabel("Close dialog").click();

  console.log("== stale-plan recovery (UI) ==");
  await page.goto(`${BASE}/admin/workloads/${workloadId}/deployment/edit`);
  await page.waitForFunction(() => {
    const t = document.querySelector("textarea");
    return t && t.value.includes("APP_SECRET");
  }, null, { timeout: 20000 });
  await setEditorValue(
    page,
    (marker) => {
      const t = document.querySelector("textarea");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      const next = t.value.replace("UI_MARKER: " + marker, "UI_MARKER: " + marker + "-b");
      setter.call(t, next);
      t.dispatchEvent(new Event("input", { bubbles: true }));
      return next;
    },
    MARKER_REV
  );
  await page.getByRole("button", { name: "Validate" }).click();
  await waitForText(page, "Validation", 30000);
  await page.getByRole("button", { name: /Save as new revision/i }).click();
  await waitForText(page, "Changes vs revision");
  await page.getByRole("button", { name: /Generate deployment plan/i }).click();
  await waitForText(page, "HostPanel will NOT");

  // Another admin rotates the secret (supported API, in-page origin) — makes
  // the on-screen plan stale.
  const rotateRes = await page.evaluate(
    async ([deploymentId, secretId, value]) => {
      const csrf = (document.cookie.match(/(?:^|;\s*)hostpanel_csrf=([^;]+)/) ?? [])[1];
      const res = await fetch(`/api/admin/deployments/${deploymentId}/secrets/${secretId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf ?? "" },
        body: JSON.stringify({ value })
      });
      return res.status;
    },
    [deploymentId, state.secretId, ROTATE_VALUES[1]]
  );
  check(rotateRes === 201, "concurrent secret rotation succeeded (simulated second admin)");

  await page.getByRole("button", { name: /Deploy revision/i }).click();
  await waitForText(page, "Deployment plan is out of date", 30000);
  await shot(page, "stale-plan-banner");
  check((await bodyText(page)).includes("generate new plan"), "stale-plan banner offers plan regeneration");

  await page.getByRole("button", { name: /Generate new plan/i }).click();
  await waitForText(page, "HostPanel will NOT", 30000);
  await shot(page, "stale-plan-regenerated");
  await page.getByRole("button", { name: /Deploy revision/i }).click();
  await waitForText(page, "Deployment completed successfully", 120000);
  await page.getByRole("button", { name: /Back to workload/i }).click();
  await page.waitForURL(/\/admin\/workloads\/\w+$/);

  console.log("== degraded deployment (UI) ==");
  await page.goto(`${BASE}/admin/workloads/${workloadId}/deployment/edit`);
  await page.waitForFunction(() => {
    const t = document.querySelector("textarea");
    return t && t.value.includes("APP_SECRET");
  }, null, { timeout: 20000 });
  await setEditorValue(page, () => {
    const t = document.querySelector("textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    const next = t.value.replace('test: ["CMD-SHELL", "test -n \\"$$APP_SECRET\\""]', 'test: ["CMD-SHELL", "exit 1"]');
    setter.call(t, next);
    t.dispatchEvent(new Event("input", { bubbles: true }));
    return next;
  });
  await page.getByRole("button", { name: "Validate" }).click();
  await waitForText(page, "Validation", 30000);
  await page.getByRole("button", { name: /Save as new revision/i }).click();
  await waitForText(page, "Changes vs revision");
  await page.getByRole("button", { name: /Generate deployment plan/i }).click();
  await waitForText(page, "HostPanel will NOT");
  await page.getByRole("button", { name: /Deploy revision/i }).click();
  await waitForText(page, "health verification failed", 180000);
  await shot(page, "degraded-result");
  text = await bodyText(page);
  check(text.includes("the new configuration is currently running"), "degraded UX says configuration is running");
  check(text.includes("rollback"), "degraded result offers rollback");
  check(!/deployment failed\.$/.test(text), "degraded UX does NOT show generic 'Deployment failed.'");
  check(text.includes("previous healthy release"), "degraded UX references the previous healthy release");

  await page.getByRole("button", { name: "Inspect workload" }).click();
  await page.waitForURL(/\/admin\/workloads\/\w+$/);
  await waitForText(page, "Degraded", 30000);
  await shot(page, "overview-managed-card-degraded");
  text = await bodyText(page);
  check(text.includes("degraded"), "overview card shows Degraded");
  check(text.includes("last healthy"), "overview card shows Last healthy");

  console.log("== rollback (UI) ==");
  await openTab(page, workloadId, "Deployments");
  await waitForText(page, "Current state");
  await shot(page, "deployments-tab-degraded");
  await page.getByRole("button", { name: "Rollback" }).first().click();
  await waitForText(page, "Rollback target");
  await shot(page, "rollback-target");
  text = await bodyText(page);
  check(text.includes("current versions"), "rollback explains current secret versions are used");
  check(text.includes("not restored"), "rollback explains historical secret values are not restored");
  await page.getByRole("button", { name: /Generate rollback plan/i }).click();
  await waitForText(page, "HostPanel will NOT", 30000);
  await shot(page, "rollback-plan");
  await page.getByRole("button", { name: /Confirm rollback/i }).click();
  await waitForText(page, "Deployment completed successfully", 120000);
  await shot(page, "rollback-success");
  await page.getByRole("button", { name: /Back to workload/i }).click();
  await page.waitForURL(/\/admin\/workloads\/\w+$/);
  await openTab(page, workloadId, "Deployments");
  await waitForText(page, "ROLLBACK", 30000);
  await shot(page, "release-history-final");
  text = await bodyText(page);
  check(text.includes("rollback"), "history shows ROLLBACK release");
  check(text.includes("healthy"), "history shows HEALTHY after rollback");

  console.log("== final leak check ==");
  const fullText = await page.evaluate(() => document.documentElement.innerText);
  check(!fullText.includes(ROTATE_VALUES[0]) && !fullText.includes(ROTATE_VALUES[1]), "no rotation plaintext anywhere in the DOM");

  await browser.close();
  console.log("\nUI QUALIFICATION COMPLETE" + (failures ? ` — ${failures} FAILURES` : " — all checks passed"));
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error("UI QUALIFY ERROR:", e.message);
  process.exit(1);
});
