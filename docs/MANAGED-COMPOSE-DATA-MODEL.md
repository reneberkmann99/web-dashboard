# HostPanel — Managed Compose Data Model

Status: **Phase 6A + 6B implemented.** The schema here is applied (migrations
`managed_deployment_foundation`, `managed_release_model`, `node_compose_capability`). Phase 6B added
the `DeploymentRelease`/`DeploymentReleaseImage`/`DeploymentReleaseSecret` models (Revision != Release),
release pointers (`currentReleaseId`/`lastHealthyReleaseId`), `RuntimeState`, and `Node.transportMode`.
See ADR-0010.

---

## 1. Design goals

- Keep `Project` as the operational/user-facing workload object (unchanged semantics).
- Add ownership as a **separate** optional `Deployment` relation (ADR-0001).
- Revisions are **immutable** and **validated-on-create**; dedup by canonical content hash (ADR-0002).
- Secrets are **versioned, encrypted at rest, deployment-scoped**, referenced-by-key never
  embedded-by-value (ADR-0003).
- Deployment operations use a **new `DeploymentOperation`** table (not the container-centric
  `Operation`) with a partial unique index enforcing a deployment-level lock (ADR-0006 / §12).

---

## 2. Proposed Prisma models

```prisma
// ---------------------------------------------------------------------------
// Managed Compose deployment (Phase 5 design — NOT applied)
// ---------------------------------------------------------------------------

enum DeploymentSource {
  HOSTPANEL
  GIT          // future: no code path creates this yet
}

enum DeploymentState {
  PENDING        // created, never successfully deployed
  SUCCEEDED      // last deploy verified healthy
  DEGRADED       // last deploy applied but unhealthy/degraded
  FAILED         // last deploy failed and not yet recovered
  ROLLED_BACK    // last action was a successful rollback
  ROLLBACK_FAILED
}

enum DeploymentOperationPhase {
  VALIDATING
  PLANNING
  WAITING_FOR_CONFIRMATION
  PULLING
  APPLYING
  VERIFYING
  RECONCILING
}

model Deployment {
  id                    String          @id @default(cuid())
  projectId             String          @unique
  project               Project         @relation(fields: [projectId], references: [id], onDelete: Cascade)
  source                DeploymentSource @default(HOSTPANEL)
  composeProjectName    String          // -p value passed to `docker compose`; == Project.composeProject
  activeRevisionId      String?         // convenience: == lastDeployedRevisionId (denormalized read helper)
  lastDeployedRevisionId String?
  lastFailedRevisionId  String?
  lastDeployState       DeploymentState @default(PENDING)
  lastOperationId       String?
  verifyGraceMs         Int             @default(30000)
  pullPolicy            String          @default("ALWAYS") // ALWAYS | IF_NOT_PRESENT
  gitConfig             DeploymentGitConfig?
  secrets               Secret[]
  revisions             DeploymentRevision[]
  operations            DeploymentOperation[]
  createdAt             DateTime        @default(now())
  updatedAt             DateTime        @updatedAt

  @@index([projectId])
  @@index([lastDeployState])
}

// Future Git source configuration. Not populated in v1.
model DeploymentGitConfig {
  id            String     @id @default(cuid())
  deploymentId  String     @unique
  deployment    Deployment @relation(fields: [deploymentId], references: [id], onDelete: Cascade)
  repositoryUrl String
  ref           String     @default("main") // branch / tag / commit SHA
  composeFilePath String   @default("docker-compose.yml")
  lastSyncAt    DateTime?
  lastSyncRef   String?
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt
}

model DeploymentRevision {
  id                    String           @id @default(cuid())
  deploymentId          String
  deployment            Deployment       @relation(fields: [deploymentId], references: [id], onDelete: Cascade)
  revisionNumber        Int              // monotonic per deployment
  source                DeploymentSource @default(HOSTPANEL)
  sourceRef             String?          // future: Git commit SHA
  composeDefinition     String           // normalized `docker compose config` YAML
  environmentSnapshot   Json             // non-secret env { KEY: value } (values plaintext)
  secretReferences      String[]         // secret KEYS only, never values
  contentSha256         String
  deployNote            String?
  acknowledgedFindings  String[]         // HIGH_RISK finding ids acknowledged by ADMIN
  createdById           String?
  createdBy             User?            @relation(fields: [createdById], references: [id], onDelete: SetNull)
  createdAt             DateTime         @default(now())

  images                DeploymentRevisionImage[]

  @@unique([deploymentId, revisionNumber])
  @@unique([deploymentId, contentSha256])   // dedup identical revisions
  @@index([deploymentId])
}

// Deployed image identity snapshot (tag -> resolved digest at apply time).
model DeploymentRevisionImage {
  id           String             @id @default(cuid())
  revisionId   String
  revision     DeploymentRevision @relation(fields: [revisionId], references: [id], onDelete: Cascade)
  serviceName  String
  imageRef     String             // "myapp:v14"
  imageDigest  String?            // resolved sha256:… when known
  createdAt    DateTime           @default(now())

  @@unique([revisionId, serviceName])
  @@index([revisionId])
}

model Secret {
  id              String          @id @default(cuid())
  deploymentId    String
  deployment      Deployment      @relation(fields: [deploymentId], references: [id], onDelete: Cascade)
  key             String          // e.g. "DB_PASSWORD"
  isActive        Boolean         @default(true)
  latestVersionId String?
  versions        SecretVersion[]
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt

  @@unique([deploymentId, key])
  @@index([deploymentId])
}

model SecretVersion {
  id          String   @id @default(cuid())
  secretId    String
  secret      Secret   @relation(fields: [secretId], references: [id], onDelete: Cascade)
  versionNumber Int
  ciphertext  String   // AES-256-GCM(iv:tag:ct) keyed by DEPLOYMENT_SECRETS_KEY
  createdById String?
  createdBy   User?    @relation(fields: [createdById], references: [id], onDelete: SetNull)
  createdAt   DateTime @default(now())

  @@unique([secretId, versionNumber])
  @@index([secretId])
}

model DeploymentOperation {
  id            String                    @id @default(cuid())
  type          String                    // DEPLOY | ROLLBACK
  state         OperationState            @default(REQUESTED)
  phase         DeploymentOperationPhase?
  requestId     String                    // correlation id exposed to caller
  deploymentId  String
  deployment    Deployment                @relation(fields: [deploymentId], references: [id], onDelete: Cascade)
  revisionId    String?
  fromRevisionId String?                  // for ROLLBACK: the revision being rolled back FROM
  actorUserId   String?
  actorUser     User?                     @relation(fields: [actorUserId], references: [id], onDelete: SetNull)
  actorEmail    String?
  actorRole     Role?
  error         String?
  result        Json?
  requestedAt   DateTime                  @default(now())
  queuedAt      DateTime?
  startedAt     DateTime?
  finishedAt    DateTime?
  createdAt     DateTime                  @default(now())
  updatedAt     DateTime                  @updatedAt

  @@unique([deploymentId, state])          // NOTE: partial unique via migration WHERE state IN (REQUESTED,QUEUED,RUNNING)
  @@index([deploymentId, state])
  @@index([requestId])
}
```

> **Partial unique index note**: `@@unique([deploymentId, state])` above is a documentation shorthand.
> The actual migration must create a **partial** unique index
> `WHERE "state" IN ('REQUESTED','QUEUED','RUNNING')` (identical to the existing container-operation
> lock in `step2_domain_model`), so that at most one *active* deployment operation exists per
> deployment while terminal rows accumulate freely.

---

## 3. Why each model exists

| Model | Purpose |
|---|---|
| `Deployment` | Ownership anchor. 1:1 with `Project`; existence == "managed". Holds durable state + pointers. |
| `DeploymentGitConfig` | Future Git source metadata; separated so HOSTPANEL deployments carry no repo fields and the engine stays source-agnostic. |
| `DeploymentRevision` | Immutable, normalized, validated deployable artifact. The unit of plan/apply/rollback. |
| `DeploymentRevisionImage` | Resolved tag→digest snapshot per deploy, for image identity + rollback-by-digest. |
| `Secret` | Deployment-scoped secret identity (key + active flag + latest version pointer). |
| `SecretVersion` | Encrypted value version; rotation appends rows; latest pointer advances. |
| `DeploymentOperation` | Async lifecycle for DEPLOY/ROLLBACK; the deployment-level lock. |

Deliberately **not** modeled: a reusable `EnvironmentSet` (env is a per-revision snapshot), a global
secret vault (secrets are deployment-scoped), a separate "ownership mode" enum (derived from
`Deployment` presence), and any container-level deployment table (containers are reconciled via the
existing `Container` inventory).

---

## 4. Keys, constraints, deletion behavior

- `Deployment.projectId @unique` — at most one deployment per workload; `onDelete: Cascade` so
  deleting a workload removes its deployment (revisions/secret history cascade too — see policy
  below).
- `DeploymentRevision @@unique([deploymentId, revisionNumber])` — monotonic, no gaps-in-meaning.
- `DeploymentRevision @@unique([deploymentId, contentSha256])` — dedup identical content.
- `Secret @@unique([deploymentId, key])` — one secret per key per deployment.
- `SecretVersion @@unique([secretId, versionNumber])` — monotonic versions.
- `DeploymentOperation` partial unique on `(deploymentId) WHERE state IN (REQUESTED,QUEUED,RUNNING)` —
  the deployment lock.

**Deletion policy** (mirrors existing "never hard-delete history" posture):

- Revoking management = **soft-deactivate** the `Deployment` (a `managingActive`-style flag or reuse
  of `Project.isActive` semantics) rather than hard delete, so revision/audit history is retained.
- Hard deletion of a `Deployment` cascades to revisions, image snapshots, secrets, and secret
  versions. This is only reachable via an explicit admin "forget deployment" action in a future
  phase, and is audited.
- `DeploymentRevision.createdBy` and `SecretVersion.createdBy` are `onDelete: SetNull` (history
  survives user deletion).

---

## 5. Migration implications (from current production schema)

Current schema (relevant): `Project` (with `source MANUAL|COMPOSE`, `composeProject`),
`Container`, `AccessGrant`, `Operation` (container-centric), `AuditLog`, `Node`, `User`.

- **No change to `Project`** is required — ownership is a new relation, not a new column on
  `Project.source`. (Optionally a computed `managed` flag is exposed in views, not stored.)
- New tables: `Deployment`, `DeploymentGitConfig`, `DeploymentRevision`, `DeploymentRevisionImage`,
  `Secret`, `SecretVersion`, `DeploymentOperation`.
- New enums: `DeploymentSource`, `DeploymentState`, `DeploymentOperationPhase`. `DeploymentOperation`
  reuses the existing `OperationState` enum.
- **Index**: partial unique index for the deployment lock (new migration).
- **Migration sequencing**: because the slim runtime image only supports `migrate deploy` (schema
  edits require an image rebuild — see ARCHITECTURE.md §3), these tables ship as a normal additive
  migration; nothing existing is altered, so the change is purely additive and backward-compatible.
- **Backfill**: none. Existing workloads are `EXTERNAL_COMPOSE` or `MANUAL`; no `Deployment` rows are
  created by migration. Mailcow remains externally managed.

---

## 6. De-normalization decisions

- `Deployment.activeRevisionId` is a denormalized copy of `lastDeployedRevisionId` provided as a
  convenience read. It must be maintained transactionally with `lastDeployedRevisionId` in the
  deploy/rollback executor (or dropped in favor of a single pointer — implementation may choose one
  field to avoid drift; the proposal keeps both only if the executor updates them atomically).
- `Deployment.lastDeployState` is a denormalized summary of the most recent `DeploymentOperation`
  outcome, updated transactionally with the operation's terminal transition.
- No other denormalization: drift risk is not worth the read savings at current scale.
