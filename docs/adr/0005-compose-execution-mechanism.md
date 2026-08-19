# ADR-0005: Compose execution mechanism

- **Status**: Proposed (Phase 5 design; not implemented)
- **Date**: 2026-08-19

## Context

The agent must validate, plan, pull, apply, and verify Compose deployments. The wrong choice here
(e.g. reimplementing Compose orchestration, or exposing raw shell) is a large correctness and security
risk.

## Decision

- Use the **official Docker Compose v2 CLI/plugin** via `spawn("docker", ["compose", ...])` with the
  same argument-array, never-shell discipline as the existing `RootlessDockerAdapter`.
- **Do not reimplement Compose orchestration** — normalization, recreation decisions, and apply are
  all delegated to Compose itself.
- Expose a **curated** set of compose subcommands only: `config`, `pull`, `up -d`, `ps`. The control
  plane can never send an arbitrary command.
- Detect availability (`docker compose version`) and report `composeSupported` + version in `/info`;
  minimum v2.20+ (older degrades to HostPanel's own diff, plan marked "predicted").
- Capture stdout+stderr, mask secrets, enforce per-phase timeouts and exit-code handling.

## Alternatives considered

1. **A Compose library/SDK (e.g. compose-go)** — rejected: adds a heavy dependency, diverges from the
   exact behavior of the installed CLI, and complicates the agent runtime.
2. **Reimplement `up`/reconcile ourselves over the Docker API** — rejected: high correctness risk and
   maintenance burden; the brief explicitly prefers official semantics.
3. **Raw `docker compose` shell passthrough** — rejected: no shell, no arbitrary args, no user
   strings interpolated.

## Consequences

- Correct, maintainable behavior that matches what operators already expect from `docker compose`.
- The agent remains a narrow, whitelisted surface (no new arbitrary authority).

## Security implications

- No command-injection surface (args array, typed fields, fixed subcommand set).
- Compose/parser vulnerabilities are upstream risk, mitigated by pinning + timeouts (THREAT-MODEL #18).
