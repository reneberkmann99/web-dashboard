# ADR-0009: Phase 6A design corrections

- **Status**: Accepted
- **Date**: 2026-08-19

## Context

Phase 5 produced the managed-Compose architecture. During Phase 6A implementation, thirteen
corrections were identified and ratified to tighten secret safety, remove drift-prone pointers, and
align the schema with what Phase 6A actually implements. These amend the ADRs above; they are
recorded here rather than silently rewriting historical reasoning.

## Corrections (each amends the noted ADR)

1. **No secret-interpolated `docker compose config` output is persisted** (amends ADR-0002, ADR-0003).
   `composeSource` retains placeholders; `composeCanonical` is normalized by Compose **with
   deterministic secret sentinels**, never real secret values. Persisted revision data cannot contain
   real secret plaintext.
2. **Sentinel values for validation** (amends ADR-0003). Validation sends deterministic sentinels
   (`__HOSTPANEL_SECRET_<KEY>__`) for declared secret references. Validation never calls
   `decryptSecret` and never sends real secret values to the agent.
3. **Secret interpolation restricted to service environment values** (amends ADR-0003). HostPanel-managed
   secret references may only supply `services.*.environment` values in v1; any other interpolation of
   a secret key is a `BLOCKED` `UNSUPPORTED` finding.
4. **`env_file:` unsupported in v1** (amends ADR-0005). HostPanel has no managed artifact model for
   external env files; user-authored `env_file:` is rejected (a future internal `--env-file` does not
   imply user-authored `env_file:` support).
5. **Relative bind sources unsupported in v1** (amends ADR-0005). Named volumes + absolute host binds
   are supported; relative bind paths are rejected.
6. **Other file-backed features out of v1** (amends ADR-0005): `env_file`, relative binds, `include`,
   multiple `-f`, `build`, top-level `configs`/`secrets` (file-backed) are rejected with specific
   findings.
7. **Simplified revision pointers** (amends ADR-0002). No `activeRevisionId`/`lastDeployedRevisionId`
   duplicate pair. Future executor uses `currentRevisionId` (verified-as-current runtime) and
   `lastSuccessfulRevisionId` (last to pass health verification). Both nullable in 6A.
8. **No redundant `Secret.latestVersionId`** (amends ADR-0003). Latest version = highest
   `SecretVersion.versionNumber`; versions allocated transactionally under `(secretId, versionNumber)`.
9. **Acknowledgements separate from immutable revisions** (amends ADR-0002, ADR-0007). Findings are a
   separate `DeploymentRevisionSecurityFinding`; acknowledgements are a separate
   `DeploymentSecurityAcknowledgement` with a deterministic finding fingerprint. Re-analysis under a
   newer analyzer policy never mutates the revision; `BLOCKED` is never acknowledgeable.
10. **Enums for closed state sets** (amends ADR-0005). `DeploymentSource`, `DeploymentOperationType`,
    `DeploymentOperationPhase`, `FindingSeverity`, `FindingCategory` are Prisma enums, not strings.
11. **Conservative deletion** (amends ADR-0002). `Project → Deployment` is `RESTRICT`; revision/secret
    history is not cascaded away by workload deletion. Normal behavior deactivates/detaches.
12. **`current` agent pointer semantics** (amends ADR-0004). `current` points at the revision verified
    as current runtime; apply runs against the candidate revision dir and `current` is atomically
    switched only after verify/reconcile.
13. **Cancellation requires verification** (amends ADR-0006). A future `RUNNING` deploy op cannot become
    `CANCELLED` on child-kill alone; cancellation → stop future work → `VERIFYING`/`RECONCILING` → a
    terminal result recording actual observed runtime state.

## Consequences

- Persisted revision data and validation traffic are secret-safe by construction.
- The 6A schema is smaller and drift-free (no duplicate/derived pointers).
- Deletion is conservative; no "forget deployment permanently" feature exists in 6A.
- The future executor (6B) consumes revisions regardless of origin and honors the corrected pointer,
  acknowledgement, and cancellation semantics.

## Security implications

- Secret plaintext can never enter revision history, validation traffic, audit, or agent state.
- Acknowledgements are policy-version-aware and cannot be silently overridden by an old ack.
- `BLOCKED` constructs can never be acknowledged or become deployable.
