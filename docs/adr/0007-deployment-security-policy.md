# ADR-0007: Deployment security policy

- **Status**: Accepted (ratified Phase 6A; amendments in ADR-0009)
- **Date**: 2026-08-19

## Context

A Compose definition is effectively a request for substantial Docker authority (privileged containers,
socket mounts, host binds, host networking, devices, capabilities). HostPanel must preflight and gate
this, and must ensure client roles can never author or trigger deployments.

## Decision

- A **preflight security analyzer** classifies findings `INFO | WARNING | HIGH_RISK | BLOCKED`.
- `BLOCKED` constructs are refused at validation (no revision). `HIGH_RISK` requires an explicit,
  persisted, audited ADMIN acknowledgment before a revision can be created.
- Only **ADMIN** can author definitions, create revisions, acknowledge findings, manage secrets, and
  deploy/rollback (capabilities `deployment.manage`/`deployment.deploy`).
- Client roles get at most `deployment.view` (grant-scoped); they can never author, acknowledge, or
  deploy. Security wins over convenience.

## Alternatives considered

1. **Allow client roles to author/deploy with per-grant permissions** — rejected: too dangerous; the
   blast radius of a malicious/compromised client deploying a socket-mount container is unacceptable.
2. **No analyzer; rely on admin judgment** — rejected: the brief requires explicit detection and
   classification, and defense-in-depth.
3. **Silently block all dangerous constructs with no override** — rejected as too rigid for v1;
   ADMIN acknowledgment for `HIGH_RISK` balances safety with legitimate use (e.g. a watchtower
   socket mount).

## Consequences

- Clear, auditable security posture; conservative defaults.
- Some legitimate-but-dangerous definitions require an extra acknowledgment step (acceptable).

## Security implications

- Reduces the risk of accidental or malicious privileged deployment to an explicitly acknowledged,
  ADMIN-only action.
- Deploying a `HIGH_RISK` revision without acknowledgment is refused at both revision-create and
  deploy time.
