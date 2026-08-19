# ADR-0008: Git integration boundary

- **Status**: Accepted (ratified Phase 6A; amendments in ADR-0009)
- **Date**: 2026-08-19

## Context

Future managed deployments may want to source Compose definitions from Git. This must be designed now
so it doesn't force a rewrite of the deployment engine later, but Git must not be required for the
first managed-deployment version.

## Decision

- `Deployment.source = HOSTPANEL | GIT` enum now; `HOSTPANEL` is the only value created in v1.
- A future `DeploymentGitConfig` (repository, ref, compose file path, env mapping) describes the Git
  source.
- Git content is **always materialized into an immutable `DeploymentRevision`** (source=GIT,
  sourceRef=commit SHA) before it reaches the engine.
- The deployment engine (plan/apply/verify/rollback) is **source-agnostic** — it consumes only
  `DeploymentRevision`, never Git directly.
- No Git credentials are stored; no GitOps reconciliation loop; no auto-sync in v1.

## Alternatives considered

1. **Deploy directly from a Git working tree on the agent** — rejected: non-deterministic (unpinned
   refs), no revision/audit trail, and couples the engine to Git.
2. **A separate Git engine path** — rejected: duplicates plan/apply/rollback logic.

## Consequences

- Git can be added as a non-breaking source later; the engine and its tests are reused unchanged.
- No Git credential surface in v1.

## Security implications

- Git credentials (future) will be secret-bound and scoped; none are introduced now.
- Pin-by-commit-SHA (recorded `sourceRef`) makes deployments auditable and reproducible.
