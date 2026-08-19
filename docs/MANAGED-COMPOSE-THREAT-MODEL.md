# HostPanel — Managed Compose Threat Model

Status: **Design artifact (Phase 5).** Deployment-specific threat model for the proposed managed
Compose feature. Extends the existing SECURITY-REVIEW.md (agent authority, transport) and the
deployment ownership model in `MANAGED-COMPOSE-ARCHITECTURE.md`.

Trust boundaries:

1. **Browser ↔ Control plane** — HTTPS/mesh (existing), session + CSRF + capability + tenant scoping.
2. **Control plane ↔ Agent** — `x-agent-key` shared secret, currently plain HTTP on the Docker bridge
   (existing; TLS is a documented precondition for remote nodes).
3. **Agent ↔ Docker daemon** — local socket (rootful or rootless).
4. **Control plane ↔ PostgreSQL** — local.

The deployment feature adds a *new* high-impact capability: the control plane can instruct the agent
to materialize files and run `docker compose`, which is effectively **arbitrary container-launch
authority**. This section treats that authority as the primary asset to protect.

---

## Threat matrix

| # | Threat | Vector / precondition | Impact | Mitigation | Residual risk |
|---|---|---|---|---|---|
| 1 | Malicious Compose definition | ADMIN (or a compromised admin session) authors a privileged/escape definition | host compromise, data theft | security analyzer (`BLOCKED`/`HIGH_RISK`+ack), ADMIN-only authoring, `docker compose config` normalization | an authorized ADMIN can still launch a dangerous-but-acknowledged workload; residual = admin insider/compromise |
| 2 | Privileged container escape | `privileged: true` accepted | host root | `HIGH_RISK` + explicit acknowledgment; BLOCKED combos (`pid:host`+`privileged`) refused | acknowledged privileged container is a known, audited risk |
| 3 | Docker socket mount | service mounts `/var/run/docker.sock` | full daemon control | analyzer flags socket mount as `HIGH_RISK` (ack) or `BLOCKED`; no socket-mount allow-list in v1 | acknowledged socket mount = deliberate admin choice |
| 4 | Host filesystem overwrite | bind mount of `/`, `/etc`, `~/.ssh`, etc. | arbitrary host write | analyzer flags sensitive bind paths as `HIGH_RISK`/`BLOCKED` | admin may acknowledge a specific host path; residual accepted |
| 5 | Arbitrary image execution | definition pulls an unknown/malicious image | malicious code at runtime | image identity snapshot (§17); no builder in v1; pull policy + digest recording; registry trust is the admin's | cannot verify image provenance without registry/signing (future) |
| 6 | Secret exfiltration via compose | definition uses `${VAR}` to read a secret and exfiltrate | secret leak | secrets injected only as env-file at apply time; output masked; secrets never in revisions/logs | a malicious container can still read its own injected env and exfiltrate — inherent; mitigated by image trust + network policy |
| 7 | Command injection | attacker controls a compose field that reaches a shell | RCE on node | `spawn("docker", argsArray)` never through shell; compose subcommands fixed; args typed/validated; `deploymentId`/`revisionId` regex + containment | none beyond the existing no-shell discipline |
| 8 | Path traversal in deployment files | `deploymentId`/`revisionId` contains `../` | write/read outside state dir | realpath containment check; strict CUID regex; reject `..`, absolute, symlink escapes | symlink race (see #10) |
| 9 | Symlink attack | attacker pre-creates symlinks in state dir | redirect compose to arbitrary file | state dir owned 0700 by agent user; agent uses `O_NOFOLLOW`-style checks / lstat before write; never follows symlinks into `current/` | local-user-only (agent user already trusted); residual low |
| 10 | Agent deployment-dir escape | crafted path in `deploymentId` | operate outside `deployments/` | containment check + state dir is agent-owned only | none beyond a compromised agent (see #18) |
| 11 | Cross-tenant deployment access | client role reaches another tenant's deployment | data leak / unauthorized deploy | `deployment.*` capabilities ADMIN-only; client deployment view additionally grant-scoped; secrets deployment-scoped | none for authoring; read is grant-scoped like all client reads |
| 12 | Forged deployment operation | attacker reuses a valid session/cookie to POST deploy | unauthorized deploy | existing CSRF double-submit + session; ADMIN-only capability; `confirmed` flag + plan gate | CSRF/session already covered; residual = session theft (out of scope) |
| 13 | Replay attack (agent) | captured `x-agent-key` replayed | unauthorized agent actions | existing: constant-time compare, rate limit, bridge isolation; **deployment secrets flowing to agent raise stakes** → require TLS before remote managed deploy | same-host bridge today = acceptable; remote = must fix (SECURITY-REVIEW §8) |
| 14 | Compromised agent | agent binary/config taken over | arbitrary Docker/fs on that node | agent has no more authority than the Docker socket it already holds; curated surface limits blast radius; secrets held only transiently | a compromised agent can already control its daemon; deployment feature adds little *new* agent authority but widens control-plane→agent data flow |
| 15 | Compromised control plane | DB/session/code compromised | everything | existing hardening (auth, CSRF, rate limit, AES-GCM keys); secrets encrypted at rest with master key **outside** DB | if both DB and master key are compromised, secrets are exposed — key is env-only, root 600 |
| 16 | Leaked Git credentials (future) | Git source stores credentials | repo/secret leak | Git is future; credentials will be secret-bound, deployment/node-scoped; no credentials stored in v1 | deferred until Git is designed |
| 17 | Secret exposure in compose output/errors | compose echoes interpolated secret in stderr | secret leak | agent masks injected secret values in captured output; control plane never logs them; revision stores only keys | compose could emit a secret it derived another way (low); masking is best-effort → keep secret surface minimal |
| 18 | Malicious YAML/parser behavior | `docker compose config` on untrusted YAML | DoS / crash of the compose/agent process | validation runs with timeout + resource limits; compose runs as the agent user (not root in rootless); `config` output size-capped | compose parser bugs are upstream; mitigate by pinning compose version + timeout |
| 19 | Secret at-rest compromise | DB dump leaked | secret exposure | AES-256-GCM; master key (`DEPLOYMENT_SECRETS_KEY`) env-only, not in DB; unique IV per version | a dump without the key reveals only ciphertext |
| 20 | Revision history leak | DB/dump reveals `environmentSnapshot` | non-secret env leak | env snapshot is non-secret by definition; secrets are never in revisions | non-secret env is intentionally revisioned; acceptable |
| 21 | DoS via many revisions/ops | unbounded revision creation | storage/queue exhaustion | revision dedup + retention policy (future); deployment lock + rate limit; paginated list | retention policy is future; rate limiting exists |
| 22 | Healthcheck / verify spoofing | no healthcheck defined | false "healthy" | verify reports "running state only" explicitly; DEGRADED on crash loop; never auto-rollback | an app can be "running" yet broken — inherent; surfaced as DEGRADED via restart counts |

---

## Threat-model highlights (summary)

1. The deployment feature is, in effect, **arbitrary container-launch authority**. Its single most
   important control is that only ADMIN can author and deploy, and dangerous constructs require
   explicit, audited acknowledgment or are blocked outright (ADR-0007).
2. **Secrets are the highest-value new asset.** Controls: encryption-at-rest with an env-only master
   key, no plaintext in revisions/audit/logs, no redisplay, versioned rotation, deployment scoping.
3. **The control-plane→agent transport is the weakest link** for secret flow. Same-host bridge is
   acceptable today; TLS is a **hard precondition** before any remote node runs a managed deployment
   that receives secret values.
4. **Rollback never restores secret values** (ADR-0006), which removes the "old secret revived by
   rollback" attack/recovery trap.
5. **Shared-resource safety** (§10) removes the highest-likelihood *availability* accident:
   accidental volume/network deletion. v1 has no code path that deletes persistent volumes or
   networks.

## Residual risks accepted for v1 (documented, not silent)

- An authorized ADMIN can acknowledge `HIGH_RISK` findings and run privileged/socket-mount containers.
- Secret exfiltration by a malicious *container* that legitimately receives a secret via env is not
  preventable by HostPanel (only by image trust + network policy).
- Compose CLI/parser vulnerabilities are upstream risk, mitigated by pinning + timeouts.
- No automatic rollback and no automatic volume deletion — conservative by design.
