# ADR-0010: Phase 6B — Secure managed deployment execution

- **Status**: Accepted
- **Date**: 2026-08-19

## Context

Phase 6B is the first phase allowed to mutate Docker through the managed-deployment subsystem. It
introduces the execution engine (plan → confirm → pull → apply → verify → reconcile → release),
rollback, a runtime-release model, secure transport gating, and replay protection.

## Decisions

1. **Revision != Release.** A `DeploymentRevision` is desired configuration; a `DeploymentRelease` is
   "HostPanel observed the workload converge to a revision with a specific set of resolved runtime
   inputs." Redeploying the same revision with a rotated secret or changed image digest produces a
   NEW release. `DeploymentRelease` snapshots image refs/digests (`DeploymentReleaseImage`) and
   secret version IDs (`DeploymentReleaseSecret`), never values.
2. **Release pointers replace revision pointers.** `Deployment.currentReleaseId` (release proven to
   match current runtime; may be DEGRADED) and `Deployment.lastHealthyReleaseId` (most recent
   HEALTHY release; rollback default). `runtimeState ∈ UNKNOWN|CONVERGED|DEGRADED|DRIFTED`.
3. **Runtime truth.** `currentReleaseId` is set only on conclusive convergence (HEALTHY or DEGRADED).
   Mixed/partial apply → `currentReleaseId = null`, `runtimeState = DRIFTED`. A degraded release
   makes the operation FAIL (with `runtimeConverged: true, health: DEGRADED`), never falsely SUCCEED.
4. **Secure transport is an execution gate.** `managedDeploymentExecutionSupported =
   composeSupported && transportMode === TLS_VERIFIED && executor enabled`. LEGACY_HTTP nodes are
   inventoried/validated but never deployed to. Phase 6A validation (sentinels) did not require TLS;
   Phase 6B (real secrets) does.
5. **HMAC replay protection.** Deployment mutation requests are signed with HMAC-SHA256 over
   `METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256\nOPERATION_ID` keyed by the per-node key. The agent
   verifies signature (constant-time), a ±5 min timestamp window, a bounded nonce cache, and the
   operation id. Body hash is over the exact received bytes.
6. **Curated agent execution API.** `prepare`, `pull`, `apply`, `verify`, `abort`, `state`; Compose
   subcommands restricted to `config`, `pull`, `up -d`, `ps`. No `down`, `rm`, `run`, `exec`, `kill`,
   `--remove-orphans`, volume/network deletion. Compose child env is deliberately restricted (never
   the full agent `process.env`). Secrets are in-memory/child-env only, never persisted, redacted
   from returned output.
7. **Plan engine (non-mutating) + stale-plan protection.** The plan compares candidate vs current
   release (config diff + secret-version diff + image refs) and returns a deterministic `planHash`
   bound to deployment/revision/content/release/secret-version state. `deploy`/`rollback` carry the
   `planHash`; a state change yields `PLAN_STALE` before any mutation. Security is re-analyzed
   immediately before execution.
8. **Locking.** Deployment-level lock (partial unique index) + mutual exclusion with container
   start/stop/restart and workload restart (both directions).
9. **Cancellation.** Cancel stops future stages, best-effort aborts, then VERIFY + RECONCILE records
   actual runtime (may be `DRIFTED`) — cancellation is not rollback and does not assume Docker
   unchanged.
10. **Rollback.** ADMIN-triggered, configuration-only, defaults to the previous healthy release,
    uses current secret versions, and creates a NEW release (never resurrects an old release).

## Consequences

- Accurate runtime representation (healthy/degraded/drifted) and correct release accounting.
- Secret/image runtime identity is recorded per release, enabling "secret changed — redeploy
  required".
- Execution is hard-gated on secure transport; the engine is implemented and tested but remains
  DENIED on LEGACY_HTTP nodes (TLS/PKI deployment is a separate follow-up).

## Security implications

- Secret plaintext never enters revision history, release snapshots, audit, logs, or agent disk.
- Replayed/tampered/expired mutation requests are rejected.
- No path deletes volumes/networks or removes orphans; no arbitrary shell/CLI; client roles and
  EXTERNAL_COMPOSE workloads cannot trigger execution.
