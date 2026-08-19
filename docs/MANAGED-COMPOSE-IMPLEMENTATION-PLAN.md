# HostPanel — Managed Compose Implementation Plan

Status: **Phase 6A + 6B complete; 6C–6E remain.** Phase 6A (foundation) and Phase 6B (execution
engine: release model, plan engine, secure-transport gate, HMAC replay protection, curated agent
execution API, rollback) are implemented and tested (176 tests). TLS/PKI deployment (making a node
`TLS_VERIFIED`) and the Phase 6C UI remain.

Guiding principle: **ship safety-critical primitives first** (models, secrets-at-rest, validation,
security analyzer) *before* any code path that can mutate a real Docker workload. Deployment
execution, then rollback/UI, then Git/import, come later and gated.

---

## Phase 6A — Managed deployment foundation (no real deployment yet)

Goal: the data model, validation, security analysis, and secrets-at-rest exist, but **no `docker
compose up` is ever run** and no production workload is touched.

1. **Schema migration** — add `Deployment`, `DeploymentGitConfig`, `DeploymentRevision`,
   `DeploymentRevisionImage`, `Secret`, `SecretVersion`, `DeploymentOperation` (+ enums + partial
   unique lock index). Additive only; no backfill.
2. **Crypto refactor** — parameterize `server/security/crypto.ts` by key name; add
   `DEPLOYMENT_SECRETS_KEY`. Add `encryptSecret(keyName, value)` / `decryptSecret(keyName, payload)`.
3. **Secret service** — `server/services/secrets.ts`: create/rotate/disable/list; ADMIN-only;
   audit (no values); no redisplay.
4. **Validation service** — `server/services/deployment-validation.ts`: wrap `docker compose config`
   (agent validate endpoint) into structured `{ valid, errors, findings }`.
5. **Security analyzer** — `server/services/deployment-security.ts`: static findings
   (INFO/WARNING/HIGH_RISK/BLOCKED) over the normalized compose model; acknowledgment persistence.
6. **Revision service** — `server/services/deployment-revisions.ts`: create (validated, immutable),
   dedup by content hash, list, get.
7. **Deployment service (read/authoring)** — create deployment (Project+Deployment+revision #1),
   get, list, `POST …/revisions`, `POST …/validate`. **No** deploy/plan/apply endpoints yet.
8. **Capabilities** — add `deployment.view/manage/deploy` to `server/auth/policy.ts`; ADMIN gets all;
   client roles get `deployment.view` (grant-scoped).
9. **Tests** — validation, security analyzer severity mapping, secret encryption round-trip +
   rotation + no-redisplay, revision immutability + dedup, ownership derivation, capability matrix.

**Exit criterion**: models + validation + secrets-at-rest are correct and covered by tests; zero
Docker mutation.

---

## Phase 6B — Deployment execution (plan / apply / verify)

Goal: the agent can materialize a revision and run Compose, surfaced through async operations.

1. **Agent deployment endpoints** — `validate`, `state`, `plan`, `pull`, `apply`, `verify`,
   `rollback`, `revisions` (§6 of API doc); compose execution via `docker compose` v2 with
   argument-array discipline, containment checks, secret masking.
2. **Agent state dir** — configurable `AGENT_STATE_DIR`, rootless-aware default, 0700/0600 perms,
   atomic `current` symlink switch, secret temp-file handling; report `stateDir` +
   `deploymentsSupported` in `/info`.
3. **Agent Compose adapter** — `ComposeAdapter` (version detect, `config`, `pull`, `up -d`, `ps`);
   extend `RootlessDockerAdapter` or add a sibling.
4. **Plan engine** — `server/services/deployment-plan.ts`: desired vs current diff, summary, shared-
   resource flags, uncertainty markers, image digest diff.
5. **DeploymentOperation executor** — `server/services/deployment-operations.ts`: REQUESTED→…→
   terminal + phases; deployment lock enforcement; sweeper integration (verify-based recovery) in
   `instrumentation.ts`.
6. **Deploy/rollback/cancel endpoints** + plan-confirm gate.
7. **Health verification** — `verify` with grace period, SUCCESS/DEGRADED/FAILED; no auto-rollback.
8. **Tests** — plan diff, lock conflict, sweeper recovery (idempotent verify), verify verdicts,
   compose-unavailable degradation, secret masking in output.

**Exit criterion**: a revision can be planned, applied, verified, and rolled back on a test node
(including rootless), with no automatic rollback and no volume/network deletion.

---

## Phase 6C — Rollback + UI

1. **Deployments tab** on managed workload detail (active revision, history, status, image changes,
   rollback action with §16 explanation, view definition/diff).
2. **Create-new managed workload wizard** (§19.2).
3. **Revision diff view** + human-readable plan rendering.
4. **Rollback UI** with explicit consequences dialog.
5. **Activity integration** — deployment audit events surfaced in the existing Activity view.
6. **Tests** — UI-level (Playwright) for the create/plan/deploy/rollback happy paths and the
   rollback-explanation gate.

**Exit criterion**: an admin can manage a Compose deployment end-to-end through the UI with clear,
conservative semantics.

---

## Phase 6D — Git integration boundary (future)

1. `DeploymentGitConfig` populate + sync (fetch repo/ref/path → materialize `DeploymentRevision`).
2. Git credential handling (secret-bound, deployment/node-scoped) — separate security review.
3. No auto-sync/GitOps loop.

**Not scheduled** in the near term; enabled by the source-agnostic engine from Phase 6A.

---

## Phase 6E — Managed import / take ownership (future)

1. Agent read of `com.docker.compose.project.config_files` labels (allow-listed path, admin confirm).
2. Import review UI + acknowledgment + revision #1.
3. Secret re-entry (never auto-extracted).

Scheduled after the core engine; Mailcow stays externally managed until a deliberate import.

---

## Dependency order rationale (why secrets are in 6A)

- Revisions reference secrets **by key**, so the `Secret`/`SecretVersion` model and its encryption
  must exist before any revision-creation code.
- But *secret injection into compose* is a 6B concern (it only matters once we actually apply).
- Validation/security-analyzer must precede any revision persistence (revisions are
  validated-on-create by definition).
- The deployment engine (6B) is source-agnostic, which is what makes Git (6D) and import (6E)
  non-breaking additions.

**Recommended gating rule**: Phase 6B must not ship until the 6A security analyzer and secret model
are in place and tested; Phase 6C (rollback) must not ship before verify/recovery (6B) is proven.

---

## Explicitly out of scope (per brief)

Kubernetes, Docker Swarm, arbitrary shell access, arbitrary Docker API proxying, full Portainer
compat, unattended image updates, GitOps reconciliation, backup engine, container image builder,
registry manager, volume-deletion workflow, automatic DB-migration rollback.

---

## Rollout safety checklist (before any real managed deployment)

1. TLS between control plane and agent (precondition for secret flow to remote nodes).
2. `DEPLOYMENT_SECRETS_KEY` generated and stored outside the DB (root 600).
3. Agent state dir confirmed writable and isolated (rootless verified).
4. Security analyzer `BLOCKED` list reviewed and enforced.
5. Deployment lock + sweeper recovery tested (kill -9 mid-apply).
6. Audit catalog confirmed (no secret values ever logged).
7. Mailcow re-verified as `EXTERNAL_COMPOSE` and untouched.
