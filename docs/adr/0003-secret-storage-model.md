# ADR-0003: Secret storage model

- **Status**: Proposed (Phase 5 design; not implemented)
- **Date**: 2026-08-19

## Context

Managed deployments need secret values (DB passwords, API keys) without embedding them in Compose
YAML or revision history, and without leaking them through audit or logs. The existing codebase has
an AES-256-GCM primitive (`server/security/crypto.ts`) keyed on a single `NODE_CREDENTIALS_KEY`.

## Decision

- Secrets are **deployment-scoped** (`Secret.deploymentId`), versioned (`SecretVersion`), and
  **encrypted at rest** with AES-256-GCM.
- Compose references secrets by **interpolation key** (`${DB_PASSWORD}`); the revision stores only
  `secretReferences: string[]` (keys), **never values**.
- Introduce a distinct master key `DEPLOYMENT_SECRETS_KEY` (64-hex, env-only, root 600), **never in
  the database**. The crypto primitive is parameterized by key name.
- Existing stored values are **never redisplayed** (API returns `hasValue` + metadata only).
- **Rotation** appends a `SecretVersion` and advances `latestVersionId`; it does **not** create a
  revision.
- **Rollback never restores old secret values** — at apply time secrets always resolve to their
  latest version.
- **Deletion** is soft (`isActive=false`); a revision referencing a disabled secret fails
  plan/validate with `missing_secret`.

## Alternatives considered

1. **Global secret vault shared across deployments** — rejected for v1: weaker tenant isolation and a
   larger attack surface; per-deployment secrets bound the blast radius.
2. **Embed secret values in revisions, encrypted** — rejected: revives secrets on rollback and puts
   ciphertext in revision history; key-reference indirection is cleaner.
3. **Plaintext secrets in env files on the agent** — rejected: violates the at-rest requirement and
   the "no plaintext in files" constraint.

## Consequences

- Clean separation: config (revisioned) vs secrets (live, versioned, key-referenced).
- Requires a crypto refactor and a master-key management story (rotation of the master key is a future
  re-encryption runbook).

## Security implications

- No plaintext secrets in revisions, audit, logs, or on the agent disk.
- Master key lives only in the environment, so a DB dump alone reveals only ciphertext.
- Rollback cannot accidentally resurrect an old secret value.
