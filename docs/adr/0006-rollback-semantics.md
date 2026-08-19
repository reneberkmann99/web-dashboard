# ADR-0006: Rollback semantics

- **Status**: Proposed (Phase 5 design; not implemented)
- **Date**: 2026-08-19

## Context

"Rollback" is ambiguous and dangerous. It must be defined precisely so users don't expect HostPanel to
reverse application data, DB migrations, or deleted external resources.

## Decision

- Rollback = **re-apply a previously successful `DeploymentRevision`** (configuration rollback).
- It does **not**: restore DB records, restore volume contents, reverse app-level migrations, restore
  deleted external resources, or restore old secret values (secrets always resolve to latest version).
- No automatic rollback in v1 — HostPanel **detects failure and offers admin-triggered rollback** only.
- The UI explains the scope explicitly before any rollback.

## Alternatives considered

1. **Full data + config rollback** — rejected: impossible in general (HostPanel cannot reverse
   arbitrary app DB migrations) and dangerous to imply.
2. **Automatic rollback on failed verify** — rejected for v1: implicit destructive behavior without an
   explicit policy; the brief's strong preference is detect-and-offer.

## Consequences

- Predictable, conservative recovery; no false expectations; no accidental data loss.
- Edge cases (old tag no longer resolves, digest unavailable, external network gone, host path gone)
  fail loudly with clear messages rather than guessing.

## Security implications

- Never reviving old secret values removes the "rollback resurrects a stale credential" risk.
- Never deleting volumes/networks during rollback preserves data safety.
