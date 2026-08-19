#!/usr/bin/env node
// Live E2E for the managed deployment engine (Phase 6B.1). Drives the real
// HostPanel ADMIN API (login → CSRF → authoring → secret → plan → deploy →
// verify → release) against a disposable fixture. Reads admin creds from .env.
import fs from "node:fs";
import crypto from "node:crypto";

const BASE = process.env.HOSTPANEL_URL ?? "http://localhost:1337";

function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, "").replace(/"$/, "");
  }
  return env;
}

const env = readEnv();
const cookies = {};

function storeSetCookies(res) {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    cookies[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}

function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function req(method, path, body) {
  const headers = { "Content-Type": "application/json", Cookie: cookieHeader() };
  if (cookies.hostpanel_csrf) headers["x-csrf-token"] = cookies.hostpanel_csrf;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  storeSetCookies(res);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function login() {
  const r = await req("POST", "/api/auth/login", { email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.json)}`);
  // Trigger CSRF cookie issuance.
  await req("GET", "/api/auth/me");
  if (!cookies.hostpanel_csrf) throw new Error("no CSRF cookie issued");
}

function secretValue() {
  return crypto.randomBytes(24).toString("hex");
}

// Fixture compose. APP_SECRET is a HostPanel secret; RELEASE_MARKER is non-secret.
function compose(releaseMarker) {
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

async function createDeployment(nodeId, compose, marker) {
  const r = await req("POST", "/api/admin/deployments", {
    nodeId,
    name: "hostpanel-e2e-managed",
    composeProjectName: "hostpanel-e2e-managed",
    compose,
    environment: { RELEASE_MARKER: marker },
    secretReferences: ["APP_SECRET"],
    acknowledgedFindings: []
  });
  if (r.status !== 201) throw new Error(`create deployment failed (${r.status}): ${JSON.stringify(r.json)}`);
  return r.json.data;
}

async function createSecret(deploymentId, key, value) {
  const r = await req("POST", `/api/admin/deployments/${deploymentId}/secrets`, { key, value });
  if (r.status !== 201) throw new Error(`create secret failed (${r.status}): ${JSON.stringify(r.json)}`);
  return r.json.data;
}

async function rotateSecret(deploymentId, secretId, value) {
  const r = await req("POST", `/api/admin/deployments/${deploymentId}/secrets/${secretId}/versions`, { value });
  if (r.status !== 201) throw new Error(`rotate secret failed (${r.status}): ${JSON.stringify(r.json)}`);
  return r.json.data;
}

async function plan(deploymentId, revisionId) {
  const r = await req("POST", `/api/admin/deployments/${deploymentId}/plan`, { revisionId });
  if (r.status !== 200) throw new Error(`plan failed (${r.status}): ${JSON.stringify(r.json)}`);
  return r.json.data;
}

async function deploy(deploymentId, revisionId, planHash) {
  const r = await req("POST", `/api/admin/deployments/${deploymentId}/deploy`, { revisionId, planHash });
  if (r.status !== 202) throw new Error(`deploy failed (${r.status}): ${JSON.stringify(r.json)}`);
  return r.json.data.operationId;
}

async function rollback(deploymentId, revisionId, planHash) {
  const r = await req("POST", `/api/admin/deployments/${deploymentId}/rollback`, { revisionId, planHash });
  if (r.status !== 202) throw new Error(`rollback failed (${r.status}): ${JSON.stringify(r.json)}`);
  return r.json.data.operationId;
}

async function waitOperation(deploymentId, operationId) {
  for (let i = 0; i < 240; i++) {
    const r = await req("GET", `/api/admin/deployments/${deploymentId}/operations/${operationId}`);
    const op = r.json.data;
    if (op && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(op.state)) return op;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("operation did not finish");
}

const PHASE = process.argv[2] ?? "first-deploy";
const NODE_ID = process.env.NODE_ID ?? "cmsyq6z5c000cn9016ao77l7o";

async function main() {
  await login();
  console.log(`# phase=${PHASE}`);

  if (PHASE === "first-deploy") {
    const d = await createDeployment(NODE_ID, compose("v1"), "v1");
    console.log(`created deployment=${d.id} revision=${d.revisionId}`);
    const secret = await createSecret(d.id, "APP_SECRET", secretValue());
    console.log(`created secret=${secret.id}`);
    const p = await plan(d.id, d.revisionId);
    console.log(`plan hash=${p.planHash} services=${JSON.stringify(p.summary)}`);
    const opId = await deploy(d.id, d.revisionId, p.planHash);
    const op = await waitOperation(d.id, opId);
    console.log(`operation=${op.state} phase=${op.phase} error=${op.error ?? ""}`);
    console.log(`result=${JSON.stringify(op.result)}`);
    return;
  }

  if (PHASE === "revision-update") {
    const d = await requireDeployment();
    const create = await req("POST", `/api/admin/deployments/${d.id}/revisions`, {
      compose: compose("v2"),
      environment: { RELEASE_MARKER: "v2" },
      secretReferences: ["APP_SECRET"],
      acknowledgedFindings: []
    });
    if (create.status !== 201 && create.status !== 200) throw new Error(`revision failed: ${JSON.stringify(create.json)}`);
    const revId = create.json.data.revisionId;
    const p = await plan(d.id, revId);
    console.log(`revision=${revId} plan=${JSON.stringify(p.summary)} services=${JSON.stringify(p.services.map((s) => [s.serviceName, s.action]))}`);
    const opId = await deploy(d.id, revId, p.planHash);
    const op = await waitOperation(d.id, opId);
    console.log(`operation=${op.state} ${JSON.stringify(op.result)}`);
    return;
  }

  if (PHASE === "secret-rotation") {
    const d = await requireDeployment();
    const secrets = (await req("GET", `/api/admin/deployments/${d.id}/secrets`)).json.data.data;
    const s = secrets.find((x) => x.key === "APP_SECRET");
    await rotateSecret(d.id, s.id, secretValue());
    // Find latest revision + plan it (same revision, new secret version).
    const revs = (await req("GET", `/api/admin/deployments/${d.id}/revisions`)).json.data.data;
    const latest = revs[0];
    const p = await plan(d.id, latest.id);
    console.log(`secretChange=${JSON.stringify(p.secretChanges)}`);
    const opId = await deploy(d.id, latest.id, p.planHash);
    const op = await waitOperation(d.id, opId);
    console.log(`operation=${op.state} ${JSON.stringify(op.result)}`);
    return;
  }

  if (PHASE === "degraded") {
    const d = await requireDeployment();
    const bad = `services:
  app:
    image: alpine:3.20
    environment:
      RELEASE_MARKER: \${RELEASE_MARKER}
      APP_SECRET: \${APP_SECRET}
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
    const create = await req("POST", `/api/admin/deployments/${d.id}/revisions`, {
      compose: bad, environment: { RELEASE_MARKER: "v2" }, secretReferences: ["APP_SECRET"], acknowledgedFindings: []
    });
    const revId = create.json.data.revisionId;
    const p = await plan(d.id, revId);
    const opId = await deploy(d.id, revId, p.planHash);
    const op = await waitOperation(d.id, opId);
    console.log(`operation=${op.state} ${JSON.stringify(op.result)}`);
    return;
  }

  if (PHASE === "rollback") {
    const d = await requireDeployment();
    const p = await plan(d.id, undefined); // latest revision plan (placeholder)
    // Rollback target = previous healthy release revision.
    const r = await req("POST", `/api/admin/deployments/${d.id}/rollback`, {});
    console.log(`rollback response status=${r.status} body=${JSON.stringify(r.json)}`);
    return;
  }

  throw new Error(`unknown phase ${PHASE}`);
}

async function requireDeployment() {
  // Find the fixture deployment by composeProjectName via the workloads/projects list.
  // Simpler: the caller passes DEPLOYMENT_ID env; otherwise discover.
  if (process.env.DEPLOYMENT_ID) return { id: process.env.DEPLOYMENT_ID };
  throw new Error("set DEPLOYMENT_ID env (deployment id from first-deploy)");
}

main().catch((e) => {
  console.error("E2E ERROR:", e.message);
  process.exit(1);
});
