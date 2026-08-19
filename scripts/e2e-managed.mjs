#!/usr/bin/env node
/**
 * HostPanel managed-compose FULL-LIFECYCLE qualification (live E2E).
 *
 * Every ACTION goes through the public HostPanel ADMIN API — login → CSRF →
 * authoring → secret → plan → deploy → rotate → degrade → rollback → poll —
 * exactly the surface a future 6C UI will use. No internal service is imported.
 *
 * Runtime TRUTH (container env/health/image identity, volume/network identity,
 * production isolation) is observed read-only via the docker CLI; release /
 * secret / audit internals are read via psql only where no API exists yet
 * (there is deliberately no releases API before 6C).
 *
 * Lifecycle: first-deploy → revision-update → secret-rotation (with embedded
 * stale-plan proof) → degraded → rollback → final-verify.
 * `cleanup` removes ONLY the disposable fixture. `report` prints the release
 * history produced by the lifecycle.
 *
 * State persists in /tmp/hostpanel-e2e-managed-state.json (0600) so phases can
 * be resumed with `--from <phase>`. Plaintext secret values live ONLY in that
 * harness state file (needed for the final leak scan) and are never printed.
 *
 * Usage:
 *   node scripts/e2e-managed.mjs lifecycle [--from <phase>]
 *   node scripts/e2e-managed.mjs <phase>        (single phase, using state)
 *   node scripts/e2e-managed.mjs cleanup [--keep-state]
 *   node scripts/e2e-managed.mjs report
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const BASE = process.env.HOSTPANEL_URL ?? "http://localhost:1337";
const NODE_ID = process.env.NODE_ID ?? "cmsyq6z5c000cn9016ao77l7o";
const STATE_PATH = "/tmp/hostpanel-e2e-managed-state.json";
const PROJECT = "hostpanel-e2e-managed";

const PHASES = ["first-deploy", "revision-update", "secret-rotation", "degraded", "rollback", "final-verify"];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function secretValue() {
  return crypto.randomBytes(24).toString("hex");
}

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures += 1;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function checkEq(actual, expected, msg) {
  const ok = actual === expected;
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failures += 1;
    console.error(`  ✗ FAIL: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
  return ok;
}

function requireState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    throw new Error("no state file — run `lifecycle` (or first-deploy) first");
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function docker(args, { allowFail = false } = {}) {
  try {
    return execSync(`docker ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 }).trim();
  } catch (e) {
    if (allowFail) return "";
    throw new Error(`docker ${args} failed: ${e.stderr?.toString() ?? e.message}`);
  }
}

function rootlessDocker(args) {
  return execSync(`docker compose exec -T agent-rootless docker ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 }).trim();
}

function psql(sql) {
  const out = execSync(`docker compose exec -T postgres psql -U postgres -d hostpanel -tA -F'|'`, {
    encoding: "utf8",
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
  return out.trim();
}

function dbRelease(releaseId) {
  const rows = psql(
    `SELECT id, "revisionId", "healthVerdict", "operationId", "composeVersion", "appliedAt" FROM "DeploymentRelease" WHERE id = '${releaseId}'`
  );
  if (!rows) return null;
  const [id, revisionId, healthVerdict, operationId, composeVersion, appliedAt] = rows.split("|");
  const images = psql(
    `SELECT "serviceName", "imageId", "repoDigest", "imageRef" FROM "DeploymentReleaseImage" WHERE "releaseId" = '${releaseId}' ORDER BY "serviceName"`
  )
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [serviceName, imageId, repoDigest, imageRef] = l.split("|");
      return { serviceName, imageId: imageId || null, repoDigest: repoDigest || null, imageRef: imageRef || null };
    });
  const secrets = psql(
    `SELECT key, "versionNumber", "secretVersionId" FROM "DeploymentReleaseSecret" WHERE "releaseId" = '${releaseId}' ORDER BY key`
  )
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [key, versionNumber, secretVersionId] = l.split("|");
      return { key, versionNumber: Number(versionNumber), secretVersionId };
    });
  return { id, revisionId, healthVerdict, operationId, composeVersion, appliedAt, images, secrets };
}

function dbOperationType(operationId) {
  return psql(`SELECT type FROM "DeploymentOperation" WHERE id = '${operationId}'`);
}

function containerEnv(name) {
  const out = docker(`inspect ${name} -f '{{range .Config.Env}}{{println .}}{{end}}'`);
  const env = {};
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

function containerHealth(name) {
  return docker(`inspect ${name} -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'`);
}

function containerStartedAt(name) {
  return docker(`inspect ${name} -f '{{.State.StartedAt}}'`);
}

// ---------------------------------------------------------------------------
// API client (public ADMIN API only)
// ---------------------------------------------------------------------------

function readEnvFile() {
  const env = {};
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return env;
}

const envFile = readEnvFile();
const cookies = {};

function storeSetCookies(res) {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    cookies[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}

async function req(method, path, body) {
  const headers = { "Content-Type": "application/json", Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") };
  if (cookies.hostpanel_csrf) headers["x-csrf-token"] = cookies.hostpanel_csrf;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  storeSetCookies(res);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function login() {
  const r = await req("POST", "/api/auth/login", { email: envFile.SEED_ADMIN_EMAIL, password: envFile.SEED_ADMIN_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.json)}`);
  await req("GET", "/api/auth/me");
  if (!cookies.hostpanel_csrf) throw new Error("no CSRF cookie issued");
}

async function getDeployment(id) {
  const r = await req("GET", `/api/admin/deployments/${id}`);
  if (r.status !== 200) throw new Error(`get deployment failed (${r.status}): ${JSON.stringify(r.json)}`);
  return r.json.data;
}

async function waitOperation(deploymentId, operationId, expectSuccess = null) {
  for (let i = 0; i < 360; i++) {
    const r = await req("GET", `/api/admin/deployments/${deploymentId}/operations/${operationId}`);
    const op = r.json.data;
    if (op && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(op.state)) {
      if (expectSuccess === true && op.state !== "SUCCEEDED") {
        throw new Error(`operation ${operationId} expected SUCCEEDED but is ${op.state}: ${op.error ?? JSON.stringify(op.result)}`);
      }
      if (expectSuccess === false && op.state !== "FAILED") {
        throw new Error(`operation ${operationId} expected FAILED but is ${op.state}`);
      }
      return op;
    }
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  throw new Error(`operation ${operationId} did not finish within 6 minutes`);
}

// ---------------------------------------------------------------------------
// Fixture compose definitions
// ---------------------------------------------------------------------------

function composeHealthy(marker) {
  return `services:
  app:
    image: alpine:3.20
    environment:
      RELEASE_MARKER: \${RELEASE_MARKER}
      APP_SECRET: \${APP_SECRET}
    volumes:
      - e2e-data:/data
    command: ["sh", "-c", "test -n \\"$$APP_SECRET\\" && while true; do sleep 3600; done"]
    healthcheck:
      test: ["CMD-SHELL", "test -n \\"$$APP_SECRET\\""]
      interval: 5s
      timeout: 2s
      retries: 3
  sidecar:
    image: alpine:3.20
    command: ["sh", "-c", "while true; do sleep 3600; done"]
volumes:
  e2e-data:
`;
}

/** Valid compose whose app container runs fine but its healthcheck always fails. */
function composeDegraded(marker) {
  return `services:
  app:
    image: alpine:3.20
    environment:
      RELEASE_MARKER: \${RELEASE_MARKER}
      APP_SECRET: \${APP_SECRET}
    volumes:
      - e2e-data:/data
    command: ["sh", "-c", "while true; do sleep 3600; done"]
    healthcheck:
      test: ["CMD-SHELL", "exit 1"]
      interval: 5s
      timeout: 2s
      retries: 3
  sidecar:
    image: alpine:3.20
    command: ["sh", "-c", "while true; do sleep 3600; done"]
volumes:
  e2e-data:
`;
}

// ---------------------------------------------------------------------------
// Isolation baseline (requirement 10)
// ---------------------------------------------------------------------------

function snapshotContainers() {
  const fmt = "{{.Id}}|{{.Name}}|{{.State.StartedAt}}|{{.RestartCount}}";
  const rootfulIds = docker(`ps -aq`, { allowFail: true });
  const rootful = rootfulIds ? docker(`inspect ${rootfulIds.split("\n").join(" ")} -f '${fmt}'`, { allowFail: true }) : "";
  let rootless = "";
  try {
    const rootlessIds = rootlessDocker(`ps -aq`);
    rootless = rootlessIds ? rootlessDocker(`inspect ${rootlessIds.split("\n").join(" ")} -f '${fmt}'`) : "";
  } catch {
    rootless = "";
  }
  return `${rootful}\n${rootless}`;
}

function assertIsolation(baseline) {
  const now = snapshotContainers();
  const keep = (snap) =>
    snap
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.includes("hostpanel-e2e-managed"));
  const a = keep(baseline);
  const b = keep(now);
  const aLines = new Set(a);
  const bLines = new Set(b);
  const missing = [...aLines].filter((l) => !bLines.has(l));
  const added = [...bLines].filter((l) => !aLines.has(l));
  check(missing.length === 0, `no production container disappeared${missing.length ? ` — MISSING: ${missing.join(" ; ")}` : ""}`);
  check(added.length === 0, `no production container was created/restarted${added.length ? ` — ADDED: ${added.join(" ; ")}` : ""}`);
  if (missing.length || added.length) failures += 1;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function phaseFirstDeploy(state) {
  console.log("== first-deploy ==");
  const s1 = secretValue();
  const r = await req("POST", "/api/admin/deployments", {
    nodeId: NODE_ID,
    name: "hostpanel-e2e-managed",
    composeProjectName: PROJECT,
    compose: composeHealthy("v1"),
    environment: { RELEASE_MARKER: "v1" },
    secretReferences: ["APP_SECRET"],
    acknowledgedFindings: []
  });
  if (r.status !== 201) throw new Error(`create deployment failed (${r.status}): ${JSON.stringify(r.json)}`);
  const created = r.json.data;
  state.deploymentId = created.id;
  state.projectId = created.projectId;
  state.rev1 = created.revisionId;
  state.rev1Sha256 = psql(`SELECT "contentSha256" FROM "DeploymentRevision" WHERE id = '${created.revisionId}'`);
  console.log(`  deployment=${created.id} revision1=${created.revisionId}`);

  const secret = (await req("POST", `/api/admin/deployments/${created.id}/secrets`, { key: "APP_SECRET", value: s1 })).json.data;
  state.secretId = secret.id;
  state.s1 = { plaintext: s1, sha256: sha256(s1) };
  console.log("  secret created [value masked]");

  const p = (await req("POST", `/api/admin/deployments/${created.id}/plan`, { revisionId: created.revisionId })).json.data;
  checkEq(p.summary.create, 2, "plan: 2 services to create");
  checkEq(p.summary.volumesRemoved, 0, "plan: no volume removal");
  checkEq(p.summary.networksRemoved, 0, "plan: no network removal");

  const deployRes = await req("POST", `/api/admin/deployments/${created.id}/deploy`, { revisionId: created.revisionId, planHash: p.planHash });
  checkEq(deployRes.status, 202, "deploy accepted (202)");
  const op = await waitOperation(created.id, deployRes.json.data.operationId, true);
  checkEq(op.state, "SUCCEEDED", "first deploy operation SUCCEEDED");
  checkEq(op.result?.verify?.verdict, "CONVERGED_HEALTHY", "verification CONVERGED_HEALTHY");
  checkEq(op.result?.runtimeConverged, true, "result reports runtime convergence");
  check(Boolean(op.result?.releaseId), "operation result carries releaseId");
  state.r1 = op.result.releaseId;
  checkEq(dbOperationType(op.id), "DEPLOY", "operation type DEPLOY");

  const dep = await getDeployment(created.id);
  checkEq(dep.runtimeState, "CONVERGED", "deployment runtimeState CONVERGED");
  checkEq(dep.currentReleaseId, state.r1, "currentReleaseId = release 1");
  checkEq(dep.lastHealthyReleaseId, state.r1, "lastHealthyReleaseId = release 1");

  // Runtime truth.
  const appEnv = containerEnv(`${PROJECT}-app-1`);
  checkEq(appEnv["RELEASE_MARKER"], "v1", "running container has RELEASE_MARKER=v1");
  checkEq(sha256(appEnv["APP_SECRET"]), state.s1.sha256, "running container has secret version 1 (sha256 match, value masked)");
  checkEq(containerHealth(`${PROJECT}-app-1`), "healthy", "app container healthy");
  checkEq(containerHealth(`${PROJECT}-sidecar-1`), "none", "sidecar has no healthcheck");

  // Persistent resources + image identity.
  state.volumeName = `${PROJECT}_e2e-data`;
  state.volumeCreatedAt = docker(`volume inspect ${state.volumeName} -f '{{.CreatedAt}}'`);
  state.networkName = `${PROJECT}_default`;
  state.networkId = docker(`network inspect ${state.networkName} -f '{{.Id}}'`);
  state.appImageId = docker(`inspect ${PROJECT}-app-1 -f '{{.Image}}'`);
  state.repoDigest = docker(`image inspect ${state.appImageId} -f '{{index .RepoDigests 0}}'`, { allowFail: true }) || null;
  console.log(`  volume=${state.volumeName} network=${state.networkName}`);
  console.log(`  app imageId=${state.appImageId} repoDigest=${state.repoDigest}`);

  const rel = dbRelease(state.r1);
  checkEq(rel.healthVerdict, "HEALTHY", "release 1 healthVerdict HEALTHY");
  checkEq(rel.revisionId, created.revisionId, "release 1 revisionId = revision 1");
  checkEq(rel.images.find((i) => i.serviceName === "app")?.imageId, state.appImageId, "release 1 image snapshot matches running container .Image");
  checkEq(rel.images.find((i) => i.serviceName === "app")?.repoDigest ?? null, state.repoDigest, "release 1 repoDigest matches docker image metadata");
  checkEq(rel.secrets[0]?.versionNumber, 1, "release 1 snapshots secret version 1");

  saveState(state);
}

async function phaseRevisionUpdate(state) {
  console.log("== revision-update ==");
  const d = state.deploymentId;
  const create = await req("POST", `/api/admin/deployments/${d}/revisions`, {
    compose: composeHealthy("v2"),
    environment: { RELEASE_MARKER: "v2" },
    secretReferences: ["APP_SECRET"],
    acknowledgedFindings: []
  });
  checkEq(create.status, 201, "revision 2 created (not deduplicated)");
  const rev2 = create.json.data.revisionId;
  checkEq(create.json.data.revisionNumber, 2, "revision number is 2");
  check(rev2 !== state.rev1, "revision 2 is a genuinely new id");

  const revs = (await req("GET", `/api/admin/deployments/${d}/revisions`)).json.data.data;
  checkEq(revs.length, 2, "deployment has exactly 2 revisions");
  const rev1Row = revs.find((r) => r.id === state.rev1);
  checkEq(rev1Row?.contentSha256, state.rev1Sha256, "revision 1 content hash unchanged (immutable)");

  const p = (await req("POST", `/api/admin/deployments/${d}/plan`, { revisionId: rev2 })).json.data;
  checkEq(p.toRevisionNumber, 2, "plan targets revision 2");
  const appPlan = p.services.find((s) => s.serviceName === "app");
  checkEq(appPlan?.action, "RECREATE", "plan identifies app as RECREATE (env changed)");
  checkEq(p.summary.volumesRemoved, 0, "plan: no volume removal");
  checkEq(p.summary.networksRemoved, 0, "plan: no network removal");

  const deployRes = await req("POST", `/api/admin/deployments/${d}/deploy`, { revisionId: rev2, planHash: p.planHash });
  checkEq(deployRes.status, 202, "deploy accepted (202)");
  const op = await waitOperation(d, deployRes.json.data.operationId, true);
  checkEq(op.state, "SUCCEEDED", "revision-update operation SUCCEEDED");
  checkEq(op.result?.verify?.verdict, "CONVERGED_HEALTHY", "verification CONVERGED_HEALTHY");
  const r2 = op.result.releaseId;
  check(r2 && r2 !== state.r1, "new DeploymentRelease created");
  state.rev2 = rev2;
  state.r2 = r2;

  const dep = await getDeployment(d);
  checkEq(dep.runtimeState, "CONVERGED", "runtimeState CONVERGED");
  checkEq(dep.currentReleaseId, r2, "currentReleaseId points to release 2");
  checkEq(dep.lastHealthyReleaseId, r2, "lastHealthyReleaseId points to release 2");

  const appEnv = containerEnv(`${PROJECT}-app-1`);
  checkEq(appEnv["RELEASE_MARKER"], "v2", "running container has RELEASE_MARKER=v2");
  checkEq(docker(`volume inspect ${state.volumeName} -f '{{.CreatedAt}}'`), state.volumeCreatedAt, "named volume identity unchanged");
  checkEq(docker(`network inspect ${state.networkName} -f '{{.Id}}'`), state.networkId, "network identity unchanged");
  const rel = dbRelease(r2);
  checkEq(rel.healthVerdict, "HEALTHY", "release 2 HEALTHY");
  checkEq(rel.revisionId, rev2, "release 2 revisionId = revision 2");
  checkEq(rel.images.find((i) => i.serviceName === "app")?.imageId, state.appImageId, "release 2 image snapshot matches running container .Image");

  saveState(state);
}

async function phaseSecretRotation(state) {
  console.log("== secret-rotation (with embedded stale-plan proof) ==");
  const d = state.deploymentId;

  // Baseline plan BINDS the current secret version (1).
  const pOld = (await req("POST", `/api/admin/deployments/${d}/plan`, { revisionId: state.rev2 })).json.data;

  const s2 = secretValue();
  const rot = (await req("POST", `/api/admin/deployments/${d}/secrets/${state.secretId}/versions`, { value: s2 })).json.data;
  checkEq(rot.versionNumber, 2, "rotation produces secret version 2");

  const revs = (await req("GET", `/api/admin/deployments/${d}/revisions`)).json.data.data;
  checkEq(revs.length, 2, "rotation does NOT create a new revision");

  // Stale-plan attempt: old planHash no longer matches (secret version changed).
  const opsBefore = (await req("GET", `/api/admin/deployments/${d}/operations`)).json.data.total;
  const startedBefore = containerStartedAt(`${PROJECT}-app-1`);
  const staleRes = await req("POST", `/api/admin/deployments/${d}/deploy`, { revisionId: state.rev2, planHash: pOld.planHash });
  checkEq(staleRes.status, 409, "stale plan rejected with 409");
  checkEq(staleRes.json?.error?.code, "PLAN_STALE", "error code PLAN_STALE");
  const opsAfter = (await req("GET", `/api/admin/deployments/${d}/operations`)).json.data.total;
  checkEq(opsAfter, opsBefore, "stale plan created no operation");
  checkEq(containerStartedAt(`${PROJECT}-app-1`), startedBefore, "stale plan caused no container recreation (no Docker mutation)");
  checkEq(sha256(containerEnv(`${PROJECT}-app-1`)["APP_SECRET"]), state.s1.sha256, "runtime still on secret version 1 after stale-plan rejection");

  // Fresh plan + deploy.
  const pNew = (await req("POST", `/api/admin/deployments/${d}/plan`, { revisionId: state.rev2 })).json.data;
  const sc = pNew.secretChanges.find((x) => x.key === "APP_SECRET");
  checkEq(sc?.changed, true, "fresh plan reports secret-version change");
  checkEq(sc?.currentVersionNumber, 1, "plan: current secret version 1");
  checkEq(sc?.targetVersionNumber, 2, "plan: target secret version 2");

  const deployRes = await req("POST", `/api/admin/deployments/${d}/deploy`, { revisionId: state.rev2, planHash: pNew.planHash });
  checkEq(deployRes.status, 202, "rotation redeploy accepted (202)");
  const op = await waitOperation(d, deployRes.json.data.operationId, true);
  checkEq(op.state, "SUCCEEDED", "rotation redeploy operation SUCCEEDED");
  const r3 = op.result.releaseId;
  check(r3 && r3 !== state.r2, "new DeploymentRelease created for rotation");
  state.r3 = r3;
  state.s2 = { plaintext: s2, sha256: sha256(s2) };

  const rel = dbRelease(r3);
  checkEq(rel.revisionId, state.rev2, "rotation release uses the SAME revision");
  checkEq(rel.secrets[0]?.versionNumber, 2, "rotation release snapshots secret version 2");
  checkEq(sha256(containerEnv(`${PROJECT}-app-1`)["APP_SECRET"]), state.s2.sha256, "runtime actually received secret version 2 (sha256 match, value masked)");
  checkEq(docker(`volume inspect ${state.volumeName} -f '{{.CreatedAt}}'`), state.volumeCreatedAt, "named volume identity unchanged");
  checkEq(docker(`network inspect ${state.networkName} -f '{{.Id}}'`), state.networkId, "network identity unchanged");

  saveState(state);
}

async function phaseDegraded(state) {
  console.log("== degraded ==");
  const d = state.deploymentId;
  const create = await req("POST", `/api/admin/deployments/${d}/revisions`, {
    compose: composeDegraded("v3"),
    environment: { RELEASE_MARKER: "v3" },
    secretReferences: ["APP_SECRET"],
    acknowledgedFindings: []
  });
  checkEq(create.status, 201, "degraded revision created");
  const rev3 = create.json.data.revisionId;
  checkEq(create.json.data.revisionNumber, 3, "revision number is 3");

  const p = (await req("POST", `/api/admin/deployments/${d}/plan`, { revisionId: rev3 })).json.data;
  const deployRes = await req("POST", `/api/admin/deployments/${d}/deploy`, { revisionId: rev3, planHash: p.planHash });
  checkEq(deployRes.status, 202, "degraded deploy accepted (202)");
  const op = await waitOperation(d, deployRes.json.data.operationId, false);
  checkEq(op.state, "FAILED", "degraded operation FAILED (honest failure, not success)");
  checkEq(op.result?.runtimeConverged, true, "result reports runtime convergence (config applied)");
  checkEq(op.result?.health, "DEGRADED", "result health = DEGRADED");
  check(Boolean(op.result?.releaseId), "result carries releaseId");
  check(op.error?.includes("health"), "operation error mentions health verification");

  const r4 = op.result.releaseId;
  state.rev3 = rev3;
  state.r4 = r4;

  const dep = await getDeployment(d);
  checkEq(dep.runtimeState, "DEGRADED", "deployment runtimeState DEGRADED (not DRIFTED, not CONVERGED)");
  checkEq(dep.currentReleaseId, r4, "currentReleaseId points to the degraded release");
  checkEq(dep.lastHealthyReleaseId, state.r3, "lastHealthyReleaseId still points to the previous healthy release");

  const rel = dbRelease(r4);
  checkEq(rel.healthVerdict, "DEGRADED", "release 4 healthVerdict DEGRADED");
  checkEq(rel.revisionId, rev3, "release 4 revisionId = revision 3");

  const appEnv = containerEnv(`${PROJECT}-app-1`);
  checkEq(appEnv["RELEASE_MARKER"], "v3", "degraded configuration actually applied (marker v3 in container)");
  checkEq(containerHealth(`${PROJECT}-app-1`), "unhealthy", "app container unhealthy (deliberate healthcheck failure)");
  checkEq(docker(`volume inspect ${state.volumeName} -f '{{.CreatedAt}}'`), state.volumeCreatedAt, "named volume identity unchanged");
  checkEq(docker(`network inspect ${state.networkName} -f '{{.Id}}'`), state.networkId, "network identity unchanged");

  // Rotate the secret ONE more time WITHOUT deploying: proves rollback uses the
  // LATEST secret version rather than the historical version of the healthy release.
  const s3 = secretValue();
  const rot = (await req("POST", `/api/admin/deployments/${d}/secrets/${state.secretId}/versions`, { value: s3 })).json.data;
  checkEq(rot.versionNumber, 3, "pre-rollback rotation produces secret version 3");
  state.s3 = { plaintext: s3, sha256: sha256(s3) };
  state.s3VersionId = psql(`SELECT id FROM "SecretVersion" WHERE "secretId" = '${state.secretId}' AND "versionNumber" = 3`);

  saveState(state);
}

async function phaseRollback(state) {
  console.log("== rollback ==");
  const d = state.deploymentId;

  // 1. Target selection via the public API (same flow the 6C UI will use).
  const targetRes = await req("GET", `/api/admin/deployments/${d}/rollback-target`);
  checkEq(targetRes.status, 200, "rollback-target endpoint available");
  const target = targetRes.json.data;
  checkEq(target.revisionId, state.rev2, "rollback target = previous healthy release's revision");
  checkEq(target.revisionNumber, 2, "rollback target revision number = 2");
  checkEq(target.fromReleaseId, state.r3, "rollback target resolves from the previous healthy release");

  // 2. Plan the target revision (fresh planHash = explicit confirmation).
  const p = (await req("POST", `/api/admin/deployments/${d}/plan`, { revisionId: target.revisionId })).json.data;

  // 3. Execute rollback through the real rollback endpoint.
  const rbRes = await req("POST", `/api/admin/deployments/${d}/rollback`, { revisionId: target.revisionId, planHash: p.planHash });
  checkEq(rbRes.status, 202, "rollback accepted (202)");
  const op = await waitOperation(d, rbRes.json.data.operationId, true);
  checkEq(op.state, "SUCCEEDED", "rollback operation SUCCEEDED");
  checkEq(op.type, "ROLLBACK", "operation type is ROLLBACK");
  const r5 = op.result.releaseId;
  check(r5 && r5 !== state.r3, "rollback creates a NEW release (old healthy release NOT reactivated)");
  state.r5 = r5;

  const rel = dbRelease(r5);
  checkEq(rel.revisionId, state.rev2, "rollback release revisionId == previous healthy revision");
  checkEq(rel.healthVerdict, "HEALTHY", "rollback release HEALTHY");
  checkEq(rel.secrets[0]?.versionNumber, 3, "rollback release uses LATEST secret version (3), not the historical one");
  checkEq(rel.secrets[0]?.secretVersionId, state.s3VersionId, "rollback release snapshots the latest secret version id");

  const dep = await getDeployment(d);
  checkEq(dep.runtimeState, "CONVERGED", "runtimeState CONVERGED after rollback");
  checkEq(dep.currentReleaseId, r5, "currentReleaseId points to the rollback release");
  checkEq(dep.lastHealthyReleaseId, r5, "lastHealthyReleaseId points to the rollback release");

  const appEnv = containerEnv(`${PROJECT}-app-1`);
  checkEq(appEnv["RELEASE_MARKER"], "v2", "rollback applied the previous configuration (marker v2 in container)");
  checkEq(sha256(appEnv["APP_SECRET"]), state.s3.sha256, "rollback runtime uses the latest secret (sha256 match, value masked)");
  checkEq(containerHealth(`${PROJECT}-app-1`), "healthy", "app container healthy after rollback");
  checkEq(docker(`volume inspect ${state.volumeName} -f '{{.CreatedAt}}'`), state.volumeCreatedAt, "named volume identity unchanged through rollback");
  checkEq(docker(`network inspect ${state.networkName} -f '{{.Id}}'`), state.networkId, "network identity unchanged through rollback");

  saveState(state);
}

async function phaseFinalVerify(state) {
  console.log("== final-verify (cross-cutting proof) ==");
  const d = state.deploymentId;

  // Persistent resources.
  checkEq(docker(`volume inspect ${state.volumeName} -f '{{.CreatedAt}}'`), state.volumeCreatedAt, "SAME named volume exists after the full lifecycle (never recreated/deleted)");
  checkEq(docker(`network inspect ${state.networkName} -f '{{.Id}}'`), state.networkId, "workload network intact and deterministic");
  checkEq(docker(`ps -a --filter name=${PROJECT} --format '{{.Names}}' | sort | tr '\n' ' '`).trim(), `${PROJECT}-app-1 ${PROJECT}-sidecar-1`, "exactly the two fixture containers exist");

  // Image identity for every release.
  const releaseIds = [state.r1, state.r2, state.r3, state.r4, state.r5];
  const currentImageId = docker(`inspect ${PROJECT}-app-1 -f '{{.Image}}'`);
  const currentDigest = docker(`image inspect ${currentImageId} -f '{{index .RepoDigests 0}}'`, { allowFail: true }) || null;
  for (const rid of releaseIds) {
    const rel = dbRelease(rid);
    const appImg = rel.images.find((i) => i.serviceName === "app");
    checkEq(appImg?.imageId ?? null, currentImageId, `release ${rid.slice(-4)} imageId matches actual running container .Image`);
    checkEq(appImg?.repoDigest ?? null, currentDigest, `release ${rid.slice(-4)} repoDigest matches docker image metadata`);
  }

  // Release history (prints the table used in the completion report).
  console.log("  release history (newest first):");
  const rows = psql(
    `SELECT r."appliedAt", r.id, r."revisionId", r."healthVerdict", o.type, rs."versionNumber"
       FROM "DeploymentRelease" r
       JOIN "DeploymentOperation" o ON o.id = r."operationId"
       LEFT JOIN "DeploymentReleaseSecret" rs ON rs."releaseId" = r.id AND rs.key = 'APP_SECRET'
      WHERE r."deploymentId" = '${d}'
      ORDER BY r."appliedAt"`
  ).split("\n").filter(Boolean);
  for (const row of rows) {
    const [appliedAt, id, revisionId, health, opType, version] = row.split("|");
    console.log(`    ${appliedAt}  release=${id.slice(-8)}  revision=${revisionId.slice(-8)}  health=${health}  op=${opType}  secretVersion=${version}`);
  }
  state.releaseHistory = rows.map((row) => {
    const [appliedAt, id, revisionId, health, opType, version] = row.split("|");
    return { appliedAt, id, revisionId, healthVerdict: health, operationType: opType, secretVersionNumber: Number(version) };
  });
  state.finalImageId = currentImageId;
  state.finalRepoDigest = currentDigest;

  // Secret leak scan: the plaintext values must appear NOWHERE except the
  // running container's own environment.
  const markers = [state.s1.plaintext, state.s2.plaintext, state.s3.plaintext];
  console.log(`  leak scan over ${markers.length} unique secret values…`);
  const grepDb = (table, cols) => {
    const clauses = cols.map((c) => `${c}::text LIKE '%' || m.marker || '%'`).join(" OR ");
    return psql(
      `SELECT count(*) FROM "${table}" t CROSS JOIN (VALUES ${markers.map((m) => `('${m}')`).join(",")}) AS m(marker) WHERE ${clauses}`
    );
  };
  const dbHits = {
    AuditLog: grepDb("AuditLog", ["action", "targetId", "sourceIp", "metadata"]),
    DeploymentRevision: grepDb("DeploymentRevision", ["composeSource", "composeCanonical", "environmentSnapshot", "deployNote", "contentSha256"]),
    DeploymentOperation: grepDb("DeploymentOperation", ["error", "result"]),
    DeploymentRelease: grepDb("DeploymentRelease", ["healthVerdict", "composeVersion"]),
    DeploymentReleaseImage: grepDb("DeploymentReleaseImage", ["imageId", "repoDigest", "imageRef", "serviceName"]),
    DeploymentReleaseSecret: grepDb("DeploymentReleaseSecret", ["key", "secretVersionId"]),
    Secret: grepDb("Secret", ["key"]),
    SecretVersion: grepDb("SecretVersion", ["ciphertext"])
  };
  for (const [table, count] of Object.entries(dbHits)) {
    checkEq(Number(count), 0, `leak scan: ${table} contains no secret plaintext`);
  }

  // Agent state files + journals + control-plane/agent logs.
  const agentStateHits = docker(`compose exec -T agent sh -c 'grep -rl -e ${markers.join(" -e ")} /data/state 2>/dev/null | head'`, { allowFail: true });
  checkEq(agentStateHits || "", "", "leak scan: agent state directory contains no secret plaintext");
  const agentRootlessStateHits = docker(`compose exec -T agent-rootless sh -c 'grep -rl -e ${markers.join(" -e ")} /data/state 2>/dev/null | head'`, { allowFail: true });
  checkEq(agentRootlessStateHits || "", "", "leak scan: rootless agent state directory contains no secret plaintext");
  for (const [cname, label] of [
    ["web-dashboard-web-1", "control-plane logs"],
    ["web-dashboard-agent-1", "rootful agent logs"],
    ["web-dashboard-agent-rootless-1", "rootless agent logs"]
  ]) {
    const hit = docker(`logs ${cname} 2>&1 | grep -c -e ${markers.join(" -e ")}`, { allowFail: true });
    checkEq(hit || "0", "0", `leak scan: ${label} contain no secret plaintext`);
  }

  // Production isolation proof (baseline captured at lifecycle start).
  assertIsolation(state.isolationBaseline);

  // Mailcow stays EXTERNAL_COMPOSE with no Deployment relation.
  const mailcow = psql(
    `SELECT p."composeProject", p.source, (SELECT count(*) FROM "Deployment" d WHERE d."projectId" = p.id) FROM "Project" p WHERE p."composeProject" ILIKE '%mailcow%' OR p.name ILIKE '%mailcow%'`
  );
  if (mailcow) {
    const [composeProject, source, depCount] = mailcow.split("|");
    checkEq(source, "COMPOSE", `Mailcow project source stays COMPOSE (=EXTERNAL_COMPOSE derived mode)`);
    checkEq(Number(depCount), 0, "Mailcow has no Deployment relation (never auto-migrated into managed)");
  } else {
    check(false, "Mailcow project row found for isolation proof");
  }

  saveState(state);
}

async function cleanup(keepState) {
  const state = requireState();
  console.log("== cleanup (disposable fixture only) ==");
  const containers = docker(`ps -a --filter name=${PROJECT} --format '{{.Names}}'`, { allowFail: true });
  for (const name of containers.split("\n").filter(Boolean)) {
    docker(`stop ${name}`, { allowFail: true });
    docker(`rm ${name}`, { allowFail: true });
    console.log(`  removed container ${name}`);
  }
  docker(`network rm ${state.networkName}`, { allowFail: true });
  docker(`volume rm ${state.volumeName}`, { allowFail: true });
  console.log(`  removed network ${state.networkName} + volume ${state.volumeName}`);

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
  console.log("  removed fixture DB rows (releases/revisions/secrets/operations/deployment/project)");

  const leftContainers = docker(`ps -a --filter name=${PROJECT} --format '{{.Names}}'`, { allowFail: true });
  const leftNets = docker(`network ls --filter name=${PROJECT} -q`, { allowFail: true });
  const leftVols = docker(`volume ls --filter name=${PROJECT} -q`, { allowFail: true });
  checkEq([leftContainers, leftNets, leftVols].join("").trim(), "", "no hostpanel-e2e-managed* docker resources remain");
  const dbLeft = psql(`SELECT (SELECT count(*) FROM "Deployment" WHERE "composeProjectName" = '${PROJECT}') + (SELECT count(*) FROM "Project" WHERE "composeProject" = '${PROJECT}')`);
  checkEq(dbLeft, "0", "no fixture DB rows remain");

  if (!keepState) {
    fs.rmSync(STATE_PATH, { force: true });
    console.log("  state file removed");
  }
}

async function report() {
  const state = requireState();
  console.log("== qualification report (from state) ==");
  console.log(JSON.stringify({
    deploymentId: state.deploymentId,
    releases: state.releaseHistory ?? [],
    finalImageId: state.finalImageId ?? null,
    finalRepoDigest: state.finalRepoDigest ?? null,
    volumeName: state.volumeName,
    volumeCreatedAt: state.volumeCreatedAt,
    networkName: state.networkName,
    phases: state.phases ?? {}
  }, null, 2));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const MODE = process.argv[2] ?? "lifecycle";
const FROM = (() => {
  const i = process.argv.indexOf("--from");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const KEEP_STATE = process.argv.includes("--keep-state");

async function main() {
  if (MODE === "cleanup") {
    await cleanup(KEEP_STATE);
    if (failures) process.exitCode = 1;
    return;
  }
  if (MODE === "report") {
    await report();
    return;
  }

  await login();

  const state = MODE === "lifecycle" ? {} : requireState();
  state.phases = state.phases ?? {};

  if (MODE === "lifecycle") {
    // Pre-flight: clean slate + isolation baseline.
    const existing = docker(`ps -a --filter name=${PROJECT} --format '{{.Names}}'`, { allowFail: true });
    if (existing) throw new Error(`fixture already exists (${existing.split("\n").join(", ")}) — run cleanup first`);
    const dbExisting = psql(`SELECT count(*) FROM "Project" WHERE "composeProject" = '${PROJECT}'`);
    if (dbExisting !== "0") throw new Error("fixture DB rows exist — run cleanup first");
    state.isolationBaseline = snapshotContainers();
    console.log("isolation baseline captured (all containers on both daemons)");
  }

  const phases = FROM ? PHASES.slice(PHASES.indexOf(FROM)) : PHASES;
  for (const phase of phases) {
    if (MODE === "lifecycle" && phase === "first-deploy" && FROM && FROM !== "first-deploy") continue;
    const started = Date.now();
    switch (phase) {
      case "first-deploy": await phaseFirstDeploy(state); break;
      case "revision-update": await phaseRevisionUpdate(state); break;
      case "secret-rotation": await phaseSecretRotation(state); break;
      case "degraded": await phaseDegraded(state); break;
      case "rollback": await phaseRollback(state); break;
      case "final-verify": await phaseFinalVerify(state); break;
      default: throw new Error(`unknown phase ${phase}`);
    }
    state.phases[phase] = { doneAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000) };
    saveState(state);
    if (failures > 0) {
      console.error(`\n${failures} assertion(s) failed in phase ${phase} — aborting lifecycle (state preserved for resume)`);
      process.exitCode = 1;
      return;
    }
  }
  console.log("\nLIFECYCLE COMPLETE — all assertions passed.");
  console.log("Run `node scripts/e2e-managed.mjs cleanup` to remove the disposable fixture.");
}

main().catch((e) => {
  console.error("E2E ERROR:", e.message);
  process.exit(1);
});
