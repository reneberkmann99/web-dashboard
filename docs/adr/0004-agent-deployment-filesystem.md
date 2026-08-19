# ADR-0004: Agent deployment filesystem

- **Status**: Accepted (ratified Phase 6A; amendments in ADR-0009)
- **Date**: 2026-08-19

## Context

The agent must materialize deployment definitions somewhere to run `docker compose`, without touching
externally managed Compose directories and without assuming a writable `/var/lib/hostpanel` (which
rootless deployments cannot write).

## Decision

- A **configurable state directory** `AGENT_STATE_DIR`, with rootless-aware defaults
  (`${XDG_DATA_HOME:-$HOME/.local/share}/hostpanel` for rootless; `/var/lib/hostpanel` for rootful).
- Layout:
  `deployments/<deploymentId>/revisions/<NNNNNN>/{compose.yml, env}` with a `current/` symlink atomically
  repointed to the active revision dir.
- **Permissions** 0700 dirs / 0600 files; secrets are materialized only transiently (0600 temp
  `--env-file`, unlinked immediately) and never persisted.
- **Containment**: every deployment path resolves inside the state dir via `path.resolve` +
  `startsWith` and rejects traversal/symlink escape.
- **Externally managed Compose directories are never touched**; the agent only ever reads/writes its
  own state dir for deployments.
- The agent reports `stateDir` + `deploymentsSupported` in `/info`.

## Alternatives considered

1. **Hardcode `/var/lib/hostpanel`** — rejected: breaks rootless deployments.
2. **Control plane writes files over a generic FS endpoint** — rejected: widens the agent attack
   surface (arbitrary FS access); the agent must own a narrow, validated namespace.
3. **Store compose files in Postgres and stream per-run without persisting** — rejected for v1: needs
   a working copy for `docker compose -f` and for atomic revision switching/rollback.

## Consequences

- Deterministic, isolated, rootless-compatible state; safe atomic switching; clean rollback via prior
  revision dirs.
- The control plane must re-push revision content after an agent rebuild (acceptable — the DB is the
  source of truth, ADR-0002).

## Security implications

- No world-readable secret files; no writes outside the owned namespace; symlink/traversal attacks
  mitigated by containment checks.
