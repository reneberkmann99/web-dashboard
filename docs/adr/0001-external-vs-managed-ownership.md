# ADR-0001: External vs managed Compose ownership

- **Status**: Proposed (Phase 5 design; not implemented)
- **Date**: 2026-08-19

## Context

HostPanel's `Project.source` currently encodes two values, `MANUAL` and `COMPOSE`, that describe
**membership semantics** (curated vs label-reconciled), not ownership. But the product must now
distinguish three things: workloads it merely observes/operates, externally managed Compose projects
it discovers, and Compose deployments whose lifecycle HostPanel owns. Mailcow is `COMPOSE` today and
HostPanel must never start overwriting its files or driving its lifecycle.

A naive approach would add a third value to `Project.source` (e.g. `MANAGED_COMPOSE`). That risks
conflating "how membership is derived" with "who owns the definition," and any drift between the two
would be a correctness and safety bug.

## Decision

- Keep `Project.source` (`MANUAL | COMPOSE`) as **membership semantics**, unchanged.
- Introduce a separate, optional 1:1 `Deployment` entity attached to `Project`. **The presence of a
  `Deployment` row is the single source of truth for lifecycle ownership.**
- Derive the three modes at read time (`ownershipMode`):
  - `MANUAL` = `source=MANUAL`, no Deployment
  - `EXTERNAL_COMPOSE` = `source=COMPOSE`, no Deployment
  - `MANAGED_COMPOSE` = Deployment present (source is `COMPOSE`)
- Managed workloads keep `source=COMPOSE` because HostPanel's own `docker compose up` emits the same
  labels the existing reconciler already tracks.

## Alternatives considered

1. **Third `Project.source` value** (`MANAGED_COMPOSE`) — rejected: duplicates state, can drift from
   actual deployment presence, and muddies membership vs ownership.
2. **A `Project.deploymentManaged` boolean + mode enum** — rejected: boolean + enum is still redundant
   state with the same drift risk; a relation is cleaner and extensible (carries revisions, state,
   source).
3. **`Deployment` as the parent of `Project`** — rejected: `Project` is the stable, user-facing
   operational object across all phases; making `Deployment` the parent inverts a long-lived
   relationship for a new feature.

## Consequences

- Existing workloads are unaffected: no rows are backfilled, no `Project` column changes.
- The "is this managed?" check is a trivial relation existence check.
- Ownership transitions (import, detach) are simple create/delete (or soft-deactivate) of the
  `Deployment` relation, and never touch `Project.source` or grants.

## Security implications

- Ownership and access are cleanly separated: `AccessGrant` (who may operate) is independent of
  `Deployment` (who owns the definition). A managed workload can still be operated by a client via
  grants without that client gaining any deployment authority.
