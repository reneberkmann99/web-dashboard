# ADR-0002: Deployment revision source of truth

- **Status**: Accepted (ratified Phase 6A; amendments in ADR-0009)
- **Date**: 2026-08-19

## Context

Managed deployments need a revisioned definition so HostPanel can plan, apply, verify, and roll back
deterministically. The question is what the revision is, where it lives, and what "active" means.

## Decision

- A `DeploymentRevision` is **immutable once created**, always **validated-on-create** (no draft state
  in v1), with a **monotonic per-deployment `revisionNumber`**.
- Revisions are **deduplicated by canonical content hash** (`contentSha256`, unique per deployment) —
  creating identical content returns the existing revision (idempotent).
- The **control-plane database is the authoritative store** for revision content; the agent holds only
  a re-materializable working copy under its state dir.
- "Active" is split into two explicit concepts:
  - `lastDeployedRevisionId` — the last revision that reached `SUCCEEDED`/`DEGRADED` after apply+verify.
  - a "desired" pointer — what the admin intends to deploy next (for plan computation).
  We do **not** call a saved-but-not-deployed revision "active."
- Failed deployments are recorded on `DeploymentOperation` (and `Deployment.lastFailedRevisionId`),
  not by mutating the immutable revision.

## Alternatives considered

1. **Store raw author text, normalize at apply time** — rejected: non-deterministic (anchors,
   interpolation, defaults would resolve differently over time); the normalized form must be stable
   for diff/checksum.
2. **Editable revisions with a draft state** — rejected for v1: adds a concurrency surface and
   versioning ambiguity; "edit = new revision" is simpler and safer.
3. **Agent filesystem as authoritative** — rejected: loses fleet consistency and durability across
   node rebuilds.

## Consequences

- Deterministic, auditable history; safe rollback; crash recovery via re-materialization.
- Slight storage cost from storing the normalized YAML in Postgres (acceptable at current scale).
- Requires the crypto/validation refactor to be in place before any revision can be created (dependency
  ordering in the implementation plan).

## Security implications

- Immutability means a revision cannot be tampered with after creation, reducing the "definition
  swapped under a deploy" risk.
- Secrets are never part of revision content (only keys), so revision history/leak never exposes
  secret values.
