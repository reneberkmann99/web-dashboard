#!/usr/bin/env node
/**
 * Regression verification for the "no deployment yet" editor path.
 *
 * Reproduces the reported bug: opening the deployment editor on a managed
 * workload that has a deployment + revision 1 but NO release (never deployed)
 * used to render a dead page (title + "No deployment yet" + nothing else).
 *
 * Flow: create fixture via admin API (deployment + rev1, no release) → open
 * editor in browser → assert textarea seeded with rev1 compose + Validate
 * button present → Validate → Save as new revision → first-revision review
 * message → generate plan → deploy → done. Then assert the editor now loads
 * via the release path (Current runtime revision: 1).
 *
 * Cleanup removes ONLY the disposable fixture (containers/network/DB rows).
 * Usage: node scripts/ui-verify-first-deploy.mjs
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire("/tmp/pw/");
const { chromium } = require("playwright");

const BASE = process.env.HOSTPANEL_URL ?? "http://localhost:1337";

function readEnvFile() {
  const env = {};
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return env;
}
const envFile = readEnvFile();

function docker(args, { allowFail = false } = {}) {
  try {
    return execSync(`docker ${args}`, { encoding: "utf8" }).trim();
  } catch (e) {
    if (allowFail) return "";
    throw e;
  }
}

function psql(sql) {
  return execSync(`docker compose exec -T postgres psql -U postgres -d hostpanel -tA -F'|'`, {
    encoding: "utf8",
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  }).trim();
}

let CSRF_TOKEN = "";

function api(path, { method = "GET", body, cookie, csrf } = {}) {
  const res = execSync(
    `curl -sS -X ${method} -b "${cookie}" ${BASE}${path} ${body ? `-H 'Content-Type: application/json' -d '${body}'` : ""} -H 'X-CSRF-Token: ${csrf ?? CSRF_TOKEN}'`,
    { encoding: "utf8" }
  );
  return JSON.parse(res);
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures += 1;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

async function bodyText(page) {
  return (await page.evaluate(() => document.body.innerText)).toLowerCase();
}

async function waitForText(page, text, timeout = 60000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });
}

async function setEditorValue(page, value) {
  await page.evaluate((v) => {
    const t = document.querySelector("textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(t, v);
    t.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function main() {
  const suffix = crypto.randomBytes(4).toString("hex");
  const PROJECT = `hp-fixverify-${suffix}`;
  const NAME = `FixVerify ${suffix}`;
  const COMPOSE = `services:
  app:
    image: nginx:1.27-alpine
`;

  let state = { projectId: null, deploymentId: null, revisionId: null };
  let cleanupRan = false;
  const cleanup = () => {
    if (cleanupRan) return;
    cleanupRan = true;
    if (!state.projectId) return;
    console.log("== cleanup ==");
    const containers = docker(`ps -a --filter name=${PROJECT} --format '{{.Names}}'`, { allowFail: true });
    for (const name of containers.split("\n").filter(Boolean)) {
      docker(`stop ${name}`, { allowFail: true });
      docker(`rm ${name}`, { allowFail: true });
      console.log(`  removed container ${name}`);
    }
    docker(`network rm ${PROJECT}_default`, { allowFail: true });
    docker(`volume rm ${PROJECT}_data`, { allowFail: true });
    psql(
      `BEGIN;
       DELETE FROM "DeploymentRelease" WHERE "deploymentId" = '${state.deploymentId}';
       DELETE FROM "DeploymentRevision" WHERE "deploymentId" = '${state.deploymentId}';
       DELETE FROM "SecretVersion" WHERE "secretId" IN (SELECT id FROM "Secret" WHERE "deploymentId" = '${state.deploymentId}');
       DELETE FROM "Secret" WHERE "deploymentId" = '${state.deploymentId}';
       DELETE FROM "Deployment" WHERE id = '${state.deploymentId}';
       DELETE FROM "Project" WHERE id = '${state.projectId}';
       COMMIT;`
    );
    const left = docker(`ps -a --filter name=${PROJECT} --format '{{.Names}}'`, { allowFail: true }) +
      docker(`network ls --filter name=${PROJECT} -q`, { allowFail: true }) +
      docker(`volume ls --filter name=${PROJECT} -q`, { allowFail: true });
    const dbLeft = psql(
      `SELECT (SELECT count(*) FROM "Deployment" WHERE "composeProjectName" = '${PROJECT}') + (SELECT count(*) FROM "Project" WHERE "composeProject" = '${PROJECT}')`
    );
    check(left.trim() === "" && dbLeft === "0", "fixture fully removed (docker + DB)");
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  let browser = null;
  try {
    // --- login (browser) → grab session cookie for API calls ---
    browser = await chromium.launch({
      headless: true,
      executablePath: "/home/rene/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      args: ["--no-sandbox"]
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(30000);
    page.on("console", (msg) => console.log(`  [browser] ${msg.type()}: ${msg.text().slice(0, 200)}`));
    page.on("pageerror", (err) => console.error(`  [browser pageerror] ${err.message}`));

    console.log("  logging in…");
    await page.goto(`${BASE}/login`);
    await page.fill("#email", envFile.SEED_ADMIN_EMAIL);
    await page.fill("#password", envFile.SEED_ADMIN_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/admin/, { timeout: 15000 });
    console.log("  logged in");
    const cookies = await page.context().cookies(`${BASE}`);
    if (cookies.length === 0) throw new Error("no session cookie after login");
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const csrf = cookies.find((c) => c.name === "hostpanel_csrf")?.value ?? "";
    if (!csrf) throw new Error("no CSRF cookie after login");
    CSRF_TOKEN = csrf;

    // --- create fixture: managed deployment + revision 1, NO release ---
    console.log("== create fixture (deployment + rev1, no release) ==");
    const nodes = api("/api/admin/nodes", { cookie: cookieHeader });
    const node = nodes.data?.nodes?.[0];
    if (!node) throw new Error("no nodes available");
    const created = api("/api/admin/deployments", {
      method: "POST",
      cookie: cookieHeader,
      body: JSON.stringify({
        nodeId: node.id,
        name: NAME,
        composeProjectName: PROJECT,
        compose: COMPOSE,
        environment: {},
        secretReferences: [],
        acknowledgedFindings: [],
        policy: "ADMIN"
      })
    });
    if (created.error || !created.data?.id) {
      throw new Error(`fixture creation failed: ${JSON.stringify(created)}`);
    }
    state = { projectId: created.data.projectId, deploymentId: created.data.id, revisionId: created.data.revisionId };
    console.log(`  project=${state.projectId} deployment=${state.deploymentId} revision=${state.revisionId} (node ${node.name})`);

    const releases0 = api(`/api/admin/deployments/${state.deploymentId}/releases`, { cookie: cookieHeader });
    check(releases0.data?.data?.length === 0, "zero releases (never deployed)");

    // --- THE BUG REPRO: open the editor on a workload with no release ---
    console.log("== editor on workload with no deployment yet ==");
    await page.goto(`${BASE}/admin/workloads/${state.projectId}/deployment/edit`);
    await page.waitForSelector("textarea", { state: "visible", timeout: 30000 });
    await waitForText(page, "No deployment yet");
    const seeded = await page.inputValue("textarea");
    check(seeded.includes("nginx:1.27-alpine"), "editor seeded from revision 1 compose (was: blank page)");
    const shotDir = "/home/rene/.openclaw/workspace/artifacts/hostpanel-first-deploy-fix";
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: `${shotDir}/editor-no-deployment-yet.png` });
    const validateBtn = page.getByRole("button", { name: /validate/i });
    check(await validateBtn.isVisible() && (await validateBtn.isEnabled()), "Validate button visible + enabled");
    check(await page.getByRole("button", { name: /cancel/i }).isVisible(), "Cancel button visible");

    // --- validate → save as new revision → first-revision review ---
    console.log("== validate + save + plan + deploy (first revision) ==");
    await validateBtn.click();
    await waitForText(page, "valid");
    await waitForText(page, "Save as new revision");
    await page.getByRole("button", { name: /save as new revision/i }).click();
    await waitForText(page, "first revision of this workload");
    check((await bodyText(page)).includes("no previous configuration to compare against"), "review step explains first revision (not 'identical to current')");
    await page.getByRole("button", { name: /generate deployment plan/i }).click();
    await waitForText(page, "Deploy revision 1");
    await page.getByRole("button", { name: /deploy revision 1/i }).click();
    await waitForText(page, "Deployment completed successfully", 120000);
    await page.screenshot({ path: `${shotDir}/editor-after-first-deploy.png` });
    console.log("  deploy finished");

    // --- after first deploy: editor must load via release path ---
    console.log("== editor after first deploy (release path) ==");
    await page.goto(`${BASE}/admin/workloads/${state.projectId}/deployment/edit`);
    await page.waitForSelector("textarea", { state: "visible", timeout: 30000 });
    await waitForText(page, "Current runtime revision: 1");
    check((await page.inputValue("textarea")).includes("nginx:1.27-alpine"), "editor still seeded correctly via release path");
    const releases1 = api(`/api/admin/deployments/${state.deploymentId}/releases`, { cookie: cookieHeader });
    check(releases1.data?.data?.length === 1, "one release exists after first deploy");

    await browser.close();
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    cleanup();
  }
}

main();
