# HostPanel — Managed Compose API & Agent Contract

Status: **Proposed. Do NOT implement.** Specifies the REST surface and the agent contract for managed
Compose deployments, consistent with existing conventions (`ok(data)` / `fail(code,message,status,details)`,
Zod validation, `requireApiCapability`, `cuidParamSchema`, CSRF double-submit on all mutating routes).

---

## 1. Conventions (reused from the existing app)

- Response envelope: `{ ok: true, data }` on success; `{ ok: false, error: { code, message, details? } }`
  on failure (`server/http.ts`).
- All `:id` params are CUIDs validated by `cuidParamSchema`.
- Mutating `/api/*` routes require the CSRF header (middleware).
- Authorization via `requireApiCapability(...)`; deployment capabilities added to
  `server/auth/policy.ts` (`deployment.view`, `deployment.manage`, `deployment.deploy`).
- Every mutating deployment action writes an `AuditLog` event (action string, target `DEPLOYMENT` or
  `DEPLOYMENT_REVISION` or `SECRET`, metadata without secrets).

---

## 2. Capability → endpoint mapping

| Endpoint | Capability |
|---|---|
| All `GET /api/admin/deployments*` | `deployment.view` (ADMIN) |
| All `POST/PATCH/DELETE /api/admin/deployments*` | `deployment.manage` (ADMIN) |
| `POST …/deploy`, `…/rollback`, `…/plan-confirm`, `…/cancel` | `deployment.deploy` (ADMIN) |
| `* /api/admin/deployments/:id/secrets*` | `deployment.manage` (ADMIN) |
| `GET /api/client/workloads/:id/deployment` | `deployment.view` + active grant on workload |

Client roles never reach `deployment.manage`/`deployment.deploy` (ADMIN-only by construction, like
`node.manage`).

---

## 3. Admin REST surface

### 3.1 Create a managed deployment

```
POST /api/admin/deployments
```
Request:
```json
{
  "nodeId": "cuid",
  "name": "my-app",               // workload name (defaults to compose project name)
  "slug": "my-app",               // optional; auto-suffixed on collision per node
  "description": null,
  "clientAccountId": null,        // nullable: internal workload until granted
  "composeProjectName": "my-app", // -p value; must be unique per node
  "compose": "services:\n  web:\n    image: nginx:latest\n",
  "environment": { "APP_ENV": "production" },
  "secretKeys": ["DB_PASSWORD"]   // which keys are secrets (values supplied separately)
}
```
Behavior: validates on the agent (`docker compose config` + security analyzer). If valid and no
`BLOCKED` findings (and any `HIGH_RISK` findings are acknowledged — see §3.4), creates `Project`
(source=COMPOSE) + `Deployment` + `DeploymentRevision #1` atomically.
Response: `201 { id, deploymentId, revisionId, revisionNumber: 1, findings }`.
Errors: `VALIDATION_ERROR`, `SECURITY_BLOCKED {findings}`, `SECURITY_ACK_REQUIRED {findings}`,
`COMPOSE_PROJECT_TAKEN`.
Audit: `DEPLOYMENT_CREATE`.

### 3.2 Get deployment

```
GET /api/admin/deployments/:id
```
Response: `DeploymentView` — `{ id, projectId, source, composeProjectName, lastDeployState,
activeRevisionId, lastDeployedRevisionId, lastFailedRevisionId, lastOperation, createdAt, updatedAt }`.

### 3.3 List revisions

```
GET /api/admin/deployments/:id/revisions
```
Response: `{ data: RevisionSummary[], total }` — number, source, sourceRef, contentSha256,
deployNote, createdBy, createdAt, images (per-service ref/digest).

### 3.4 Create a new revision (validate + persist)

```
POST /api/admin/deployments/:id/revisions
```
Request:
```json
{
  "compose": "…",
  "environment": { "APP_ENV": "staging" },
  "secretKeys": ["DB_PASSWORD"],
  "deployNote": "bump web to v15",
  "acknowledgedFindings": ["finding:privileged"]   // required when HIGH_RISK findings present
}
```
Behavior: validates; rejects `BLOCKED`; requires acknowledgment for `HIGH_RISK`; persists immutable
revision with dedup (identical content → returns existing revision, idempotent).
Response: `201 { revisionId, revisionNumber, deduplicated: false }` (or `200 { …, deduplicated: true }`).
Errors: `VALIDATION_ERROR`, `SECURITY_BLOCKED`, `SECURITY_ACK_REQUIRED`, `MISSING_SECRET`.
Audit: `DEPLOYMENT_REVISION_CREATE`.

### 3.5 Validate only (no persist)

```
POST /api/admin/deployments/:id/validate
```
Request: `{ compose, environment, secretKeys }` → `{ valid, errors[], findings[], normalized? }`.
Read-only; no audit write (or a lightweight `DEPLOYMENT_VALIDATE` INFO event if desired).

### 3.6 Plan (diff)

```
POST /api/admin/deployments/:id/plan
```
Request: `{ revisionId }` → plan:
```json
{
  "summary": { "create": 1, "recreate": 2, "unchanged": 3, "remove": 0, "volumesRemoved": 0, "networksRemoved": 0 },
  "services": [
    { "name": "web", "action": "RECREATE", "changes": { "image": "myapp:v14 -> myapp:v15" } }
  ],
  "networks": [ { "name": "app_net", "action": "UNCHANGED", "shared": false } ],
  "volumes":  [ { "name": "app_data", "action": "UNCHANGED", "shared": false } ],
  "findings": [],
  "predicted": true,
  "uncertain": []
}
```
Audit: `DEPLOYMENT_PLAN`.

### 3.7 Deploy

```
POST /api/admin/deployments/:id/deploy
```
Request: `{ revisionId, confirmed: true, forceRecreate?: false }`.
Behavior: enforces the deployment lock (409 if one in flight); creates `DeploymentOperation`
(type=DEPLOY); returns `202 { operationId }`. `confirmed` is required when the plan contains
`HIGH_RISK` or destructive warnings.
Errors: `409 DEPLOYMENT_IN_PROGRESS`, `409 CONTAINER_OP_IN_PROGRESS`, `409 PLAN_NOT_CONFIRMED`.
Audit: `DEPLOYMENT_DEPLOY_REQUESTED`.

### 3.8 Rollback

```
POST /api/admin/deployments/:id/rollback
```
Request: `{ revisionId }` (defaults to `lastDeployedRevisionId` when omitted).
Behavior: same locking; `DeploymentOperation(type=ROLLBACK)`; `202 { operationId }`.
UI shows the §16 explanation before this call. Audit: `DEPLOYMENT_ROLLBACK_REQUESTED`.

### 3.9 Cancel

```
POST /api/admin/deployments/:id/operations/:opId/cancel
```
Behavior: `QUEUED`/`RUNNING` → `CANCELLED`; agent aborts the compose child (best-effort).
Audit: `DEPLOYMENT_OPERATION_CANCELLED`.

### 3.10 Operation status

```
GET /api/admin/deployments/:id/operations/:opId
GET /api/admin/deployments/:id/operations         (list, recent-first, paginated)
```
Response: `DeploymentOperationView` — `{ id, type, state, phase, revisionId, fromRevisionId,
actorEmail, error, requestedAt, queuedAt, startedAt, finishedAt }`.

### 3.11 Secrets

```
GET    /api/admin/deployments/:id/secrets           → [{ id, key, isActive, latestVersion: { versionNumber, createdAt, createdBy } }]  (never values)
POST   /api/admin/deployments/:id/secrets           → { key, value }            → 201 { id }  (audit: SECRET_CREATE)
POST   /api/admin/deployments/:id/secrets/:id/versions → { value }              → 201 { versionNumber } (audit: SECRET_ROTATE)
PATCH  /api/admin/deployments/:id/secrets/:id       → { isActive }              → 200 (audit: SECRET_DISABLE)
```

- `value` is write-only; never returned. No `GET …/value` endpoint exists.
- Rotation creates a new `SecretVersion`; does not create a revision.
- Disable is soft (`isActive=false`); a revision referencing a disabled secret fails plan/validate
  with `MISSING_SECRET`.

### 3.12 Get a revision definition (diff source)

```
GET /api/admin/deployments/:id/revisions/:revisionId
```
Response: `{ revisionNumber, composeDefinition, environmentSnapshot, secretReferences, contentSha256,
images, deployNote, createdAt, createdBy }`. ADMIN only; `composeDefinition`/`environmentSnapshot`
are never returned to client roles.

---

## 4. Client surface (v1: read-only status)

```
GET /api/client/workloads/:id/deployment
```
Authorization: `deployment.view` + active `AccessGrant` on the workload.
Response (no compose definition, no env, no secret values):
```json
{
  "managed": true,
  "lastDeployState": "SUCCEEDED",
  "activeRevision": { "revisionNumber": 12, "deployedAt": "…", "deployedBy": "…" },
  "lastDeploy": { "state": "SUCCEEDED", "finishedAt": "…", "error": null }
}
```
This is the *only* deployment endpoint client roles can reach.

---

## 5. Idempotency & operation semantics

- `POST …/revisions` is idempotent via content hash dedup (same content → same revision).
- `POST …/deploy` / `…/rollback` are **not** idempotent by nature; they create a new
  `DeploymentOperation` each time but are guarded by the deployment lock (a second concurrent
  request returns `409`). Re-deploying the same revision is allowed and converges (Compose up -d).
- `validate`, `plan`, `verify` are read-only and idempotent.
- Each mutating call returns a `requestId` (operation correlation) and is audited.

---

## 6. Agent contract (deployment endpoints)

All under existing `x-agent-key` auth + rate limit. Paths use `:deploymentId` (CUID) validated by
strict regex + realpath containment within the agent state dir.

### 6.1 Common request/response

Request bodies are JSON; responses are `{ nodeOnline: boolean, …payload }` or `{ error }`.

### 6.2 Endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/deployments/:deploymentId/validate` | `{ compose, env, secretRefs, secretValues? }` | `{ valid, errors[], findings[], normalized? }` |
| GET | `/deployments/:deploymentId/state` | — | `{ exists, currentRevision, lastAppliedAt }` |
| POST | `/deployments/:deploymentId/plan` | `{ revisionId }` | `{ summary, services[], networks[], volumes[], uncertain[] }` |
| POST | `/deployments/:deploymentId/pull` | `{ revisionId }` | `{ ok, images: [{service, imageRef, digest}] }` |
| POST | `/deployments/:deploymentId/apply` | `{ revisionId, projectName, forceRecreate? }` | `{ ok, services[], output }` (secret-masked) |
| POST | `/deployments/:deploymentId/verify` | `{}` | `{ verdict: SUCCESS\|DEGRADED\|FAILED, services: [{name,status,health,restartCount}] }` |
| POST | `/deployments/:deploymentId/rollback` | `{ revisionId }` | same as apply |
| GET | `/deployments/:deploymentId/revisions` | — | `{ revisions: [{revisionNumber, dir}] }` |

### 6.3 Hard constraints (repeated from §13 of the architecture doc)

- The control plane never sends an arbitrary command. The agent only ever runs a fixed set of
  compose subcommands (`config`, `pull`, `up -d`, `ps`) with typed args.
- `deploymentId` and `revisionId` are validated; the materialized path must resolve inside
  `<state-dir>/deployments/<deploymentId>/` (containment check rejects traversal/symlink escape).
- `secretValues` are held in memory / a 0600 temp `--env-file` and unlinked immediately; never
  persisted, never logged; masked in any returned compose output.

### 6.4 Secret handling on the agent

- The control plane sends resolved non-secret env (`env`) and secret values (`secretValues`) in the
  `validate`/`apply` payloads only. The agent writes them to a private temp env-file for the compose
  invocation and deletes it afterward.
- Compose stdout/stderr is scanned for any injected secret value and replaced with `***` before being
  returned to the control plane.

---

## 7. Audit event catalog (new actions)

| Action | Target | Metadata (no secrets) |
|---|---|---|
| `DEPLOYMENT_CREATE` | DEPLOYMENT | nodeId, composeProjectName, revisionNumber |
| `DEPLOYMENT_REVISION_CREATE` | DEPLOYMENT_REVISION | revisionNumber, contentSha256, acknowledgedFindings |
| `DEPLOYMENT_VALIDATE` | DEPLOYMENT | findings (INFO/WARNING only) |
| `DEPLOYMENT_PLAN` | DEPLOYMENT | revisionNumber, summary counts |
| `DEPLOYMENT_DEPLOY_REQUESTED` | DEPLOYMENT | revisionNumber, operationId |
| `DEPLOYMENT_DEPLOY_SUCCEEDED/FAILED` | DEPLOYMENT | revisionNumber, error (sanitized) |
| `DEPLOYMENT_ROLLBACK_REQUESTED/SUCCEEDED/FAILED` | DEPLOYMENT | fromRevisionNumber, toRevisionNumber |
| `DEPLOYMENT_OPERATION_CANCELLED` | DEPLOYMENT_OPERATION | operationId |
| `DEPLOYMENT_IMPORT` | DEPLOYMENT | (future) sourcePath acknowledged |
| `SECRET_CREATE` | SECRET | key (no value) |
| `SECRET_ROTATE` | SECRET | key, versionNumber (no value) |
| `SECRET_DISABLE` | SECRET | key (no value) |

Secrets are never written into `AuditLog.metadata`.
