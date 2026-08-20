# HostPanel — Architecture (as of 2026-08-18, pre-refactor baseline)

This document describes the system **as it exists today**, before the production-foundation
refactor. It is the reference point for what changes and why.

## 1. Frontend

- **Framework**: Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS.
- **Structure**:
  - `app/(auth)/login/page.tsx` — single login page, client component, posts to `/api/auth/login`.
  - `app/(dashboard)/admin/*` — admin pages (overview, users, clients, nodes, assignments,
    containers, audit-logs). Each page is a `"use client"` component using TanStack Query
    (`@tanstack/react-query`) for data fetching/mutation against the JSON API. No server
    components fetch data directly; everything goes through `lib/fetcher.ts` → `fetch()`.
  - `app/(dashboard)/client/*` — client-role pages (overview, containers list, container detail).
  - `components/ui/*` — small local design-system primitives (Button, Card, Input, Select,
    Badge, StatusBadge, MetricCard, Textarea) — no external UI kit, hand-rolled with
    `class-variance-authority` + `tailwind-merge`.
  - `components/layout/dashboard-shell.tsx` — shared sidebar/topbar shell for both admin and
    client dashboards, branches on `role` prop for nav items.
- **State**: React Query cache only; no global client state library. Toku via `sonner` for toasts.
- **Route protection (UX only)**: `middleware.ts` redirects `/admin/*` and `/client/*` to
  `/login` if the session cookie is absent — **presence check only**, not role or validity.
  Real authorization happens server-side in each API route (see §4).

## 2. Backend

- **Framework**: Next.js Route Handlers (`app/api/**/route.ts`) running in the same Next.js
  server process as the frontend — **no separate backend service** for the main app.
- **Runtime**: Node.js, `next start` in production (standalone output), single container
  `web-dashboard-web-1`.
- All business logic lives in `server/*` (not colocated with routes): `server/services/*`,
  `server/auth/*`, `server/validation/*`, `server/security/*`, `server/audit.ts`, `server/http.ts`.

## 3. Database & ORM

- **Database**: PostgreSQL 16 (Alpine image), single instance, single logical database
  `hostpanel`, container `web-dashboard-postgres-1`, named volume `hostpanel_pg`.
- **ORM**: Prisma 6.6 (`@prisma/client`). Schema at `prisma/schema.prisma`. Migrations under
  `prisma/migrations/` (currently: `202603130001_init`, `20260818180000_add_pam_auth`).
- **Client generation**: happens at Docker build time (`Dockerfile` build stage runs
  `prisma generate`); the slim runtime image does **not** carry the full `prisma` CLI toolchain
  needed for `prisma generate`/`migrate dev` — only `migrate deploy` works at runtime (a
  dedicated `prisma-cli` build stage supplies just enough of the CLI for deploy-time migrations).
  This constrains how schema changes are shipped: **schema edits require an image rebuild**,
  not just a migration apply.

### 3.1 Current schema (pre-refactor)

```
ClientAccount (id, name, slug, isActive)
  1—* User
  1—* Project
  1—* ContainerAssignment

User (id, email, displayName, passwordHash, authSource[LOCAL|PAM], pamUsername,
      role[ADMIN|CLIENT], isActive, lastLoginAt, clientAccountId?)
  1—* Session
  1—* AuditLog (as actor)

Session (id, userId, tokenHash, expiresAt, lastUsedAt)

Node (id, name, hostname, apiBaseUrl, apiKeyEncrypted, dockerContext?,
      status[ONLINE|OFFLINE|UNKNOWN|INACTIVE], isActive, lastHeartbeatAt)
  1—* Project
  1—* ContainerAssignment

Project (id, name, slug, description?, isActive, clientAccountId, nodeId)
  1—* ContainerAssignment
  # NOTE: currently created but never populated by any code path — 0 rows in production.
  # Assignments reference projectId optionally; no UI creates Projects.

ContainerAssignment (id, clientAccountId, projectId?, nodeId, dockerContainerId,
                      dockerName, image?, friendlyLabel?, allowedActions[], isActive, metadata?)
  @@unique([nodeId, dockerContainerId])

AuditLog (id, actorUserId?, actorEmail?, actorRole?, action, targetType, targetId?,
          metadata?, result[SUCCESS|FAILURE], sourceIp?, createdAt)
```

### 3.2 Known model gaps (informing Step 2 of the refactor)

1. **`Project` is vestigial.** The model exists, has a unique constraint
   `(clientAccountId, slug)`, and `ContainerAssignment.projectId` references it — but no route,
   service, or UI ever creates a Project. Grouping containers into logical stacks
   (Home Assistant, Mailcow, BookStack, Vybefy) is not actually possible today despite the
   schema implying it.
2. **No `AccessGrant` abstraction.** `ContainerAssignment` conflates three concerns: (a) the
   discovered Docker object identity (`dockerContainerId`/`dockerName`/`image`), (b) the
   client-visibility mapping, and (c) the permitted actions. This makes "grant Client X access
   to Project Y" impossible without manually assigning every container in that project one at
   a time, and it's why the admin UI still asks for a raw Docker container ID to be typed in.
3. **No `Operation`/job entity.** Container start/stop/restart
   (`server/services/containers.ts::runContainerAction`) is a **synchronous** HTTP round-trip:
   API route → `nodeAgentClient.runAction()` → agent → `docker <action>` → response bubbles
   straight back. There is no queued/tracked lifecycle, no protection against a second action
   firing while the first is still in flight, and the UI only knows success/failure at the
   moment the HTTP response returns (see §7).
4. **Coarse-grained `Role` enum.** Only `ADMIN` and `CLIENT` exist. Every client user has
   identical permissions within their client account — no read-only vs. operator vs.
   client-admin distinction.
5. **No expiration/lifecycle constraints enforced by the DB.** E.g. nothing prevents a `User`
   with `role=CLIENT` and `clientAccountId=null` (this exact case already exists today for the
   two PAM-auto-provisioned ADMIN accounts, which is correct for ADMIN but the DB doesn't
   *require* CLIENT users to have a client — it's only enforced, inconsistently, in
   application code across a few route handlers).

## 4. Authentication

Two independent authentication paths converge on the same `User` table and session mechanism:

### 4.1 Local (email + password)
- `app/api/auth/login/route.ts` looks up `User` by `email`, verifies via
  `server/auth/password.ts` (`bcryptjs`, cost 12).
- Applies only to `User.authSource === "LOCAL"`.

### 4.2 PAM (Linux system account)
- Added 2026-08-18. If the login identifier matches `/^[a-z_][a-z0-9_-]{1,31}$/` (a bare Linux
  username, not an email), the app calls a **separate host-side bridge service**
  (`/opt/hostpanel-pam/pam-auth.py`, NOT part of this repository) over HTTP
  (`server/auth/pam.ts` → `PAM_BRIDGE_URL`), which authenticates against the host's
  `/etc/shadow` via `python3-pam` and a dedicated `/etc/pam.d/hostpanel` PAM service
  definition (delegates to `common-auth`/`common-account`/`common-password`, the same stack
  used by `login`/`sudo`).
- **First successful PAM login auto-provisions a `User` row.** Username present in
  `PAM_ADMIN_USERS` env var → created as `ADMIN`; otherwise → `CLIENT`, auto-attached to a
  lazily-created `ClientAccount` named "Linux Users" with **zero** `ContainerAssignment`s
  (safe default — a new Linux account existing does not, by itself, grant access to anything).
- PAM users get a sentinel `passwordHash = "PAM_MANAGED"` (never checked; PAM is re-verified
  on every login, nothing is cached).
- The bridge is authenticated via a shared 64-char hex key (`X-Auth-Key` header, constant-time
  compared) and is network-restricted (host firewall) to the `web-dashboard` Docker bridge
  subnet + loopback.

### 4.3 Sessions
- `server/auth/session.ts`: opaque 32-byte random token, **SHA-256 hashed** before storage
  (`Session.tokenHash`) — the raw token only ever exists in the cookie and in-flight, never
  persisted. TTL configurable (`SESSION_TTL_HOURS`, default 12h), sliding `lastUsedAt` updated
  on every validated request (not currently used to extend `expiresAt`, so sessions are
  **hard-expiring**, not sliding-window).
- Cookie: `hostpanel_session`, `HttpOnly`, `SameSite=Lax`, `Secure` conditional on
  `COOKIE_SECURE` env override (added to support the current plain-HTTP mesh-only deployment)
  or `NODE_ENV=production` by default.
- Logout deletes the `Session` row by token hash (`destroySessionByToken`) — properly
  invalidates server-side, not just cookie-clearing.
- **No CSRF token exists.** Mitigated partially by `SameSite=Lax` (blocks cross-site POST from
  a plain `<form>` or `fetch` without explicit `credentials`), but there is no explicit
  double-submit or synchronizer token pattern. Acceptable at `SameSite=Lax` + JSON-only POST
  bodies (which Lax does protect against for top-level navigations), but not defense-in-depth.
- **No login rate limiting** on `/api/auth/login` today (the Docker-agent's own Express layer
  *does* have `express-rate-limit`, but the main Next.js app does not).

## 5. Authorization

- `server/auth/guards.ts`: `requireApiRole(role | role[])` is the only enforcement point,
  called at the top of every route handler. There is no shared middleware-level enforcement —
  **every single route file must remember to call the guard**; nothing fails closed by default
  if a route forgets to call it (though a manual audit of all 16 route files today shows every
  one of them does call it correctly).
- Role check is a flat `session.role !== "ADMIN"` / `!== "CLIENT"` — no capability/permission
  model, no per-action policy function. "Can this CLIENT user restart this specific container"
  is answered by tenant-scoping the DB query (`WHERE clientAccountId = session.clientAccountId`)
  combined with `assignment.allowedActions.includes(action)` — correct in effect for a
  single-tier client role, but does not generalize to multiple client-side permission levels
  (Step 4 of the refactor introduces this).
- **Tenant isolation is enforced entirely in `server/services/containers.ts`** via Prisma
  `WHERE` clauses built per-call (`getAssignmentsForSession`, `getContainerByAssignmentId`,
  `getContainerLogs`, `runContainerAction` all independently repeat the same
  `clientAccountId: session.role === "CLIENT" ? session.clientAccountId ?? "__invalid__" : {}`
  pattern). This is correct today but duplicated four times with no shared query-scoping
  helper — a missed copy in a future route is the realistic failure mode, not a fundamentally
  broken model.

## 6. Docker-agent architecture

- **Agent**: separate lightweight Express (v5) service (`agent/src/index.ts`), one process per
  node, **not** built on the same codebase/runtime as the main app (though it lives in the same
  git repo and Docker build context — `agent/Dockerfile` is a distinct multi-stage build from
  the main `Dockerfile`).
- **Deployment topology today**: both currently-registered "nodes" are actually **agent
  containers running on the same physical host** as the control plane (`vmi2804346`), just
  pointed at two different Docker sockets:
  - `agent` (port 8081) → rootful `/var/run/docker.sock`, registered as HostPanel node
    **"Main VPS"**.
  - `agent-rootless` (port 8082) → the `lenel` user's rootless Docker socket
    (`/home/lenel/.docker/run/docker.sock`, bind-mounted into the container as
    `/run/rootless.sock`), registered as node **"Vybefy (lenel rootless)"**.
  - There is currently no agent running on a genuinely remote/separate physical or virtual
    host. The multi-node model is exercised today only via "multiple Docker daemons on one
    box," which is a valid and intentional first use case (isolating rootful vs. rootless
    workloads as separate tenants) but has not yet been proven across a network boundary.
- **Docker access pattern**: `RootlessDockerAdapter` (`agent/src/docker/rootless-adapter.ts`)
  shells out to the `docker` CLI binary (`spawn("docker", [...])`, arguments always passed as
  an array — never through a shell) against whatever `DOCKER_HOST`/socket is configured. A
  `MockDockerAdapter` exists for `AGENT_DOCKER_MODE=mock` (returns static sample data, used
  before this session's work — no longer the default anywhere in production).
- **Command surface exposed by the agent** (`agent/src/index.ts`):
  - `GET /health`
  - `GET /containers` — full `docker ps -a` + `docker stats` + per-container `docker inspect`
  - `GET /containers/:id`
  - `GET /containers/:id/logs?tail=N` (capped 1–500)
  - `POST /containers/:id/:action` — action restricted to `start|stop|restart` via Zod enum
- **This is a curated, whitelisted surface, not a raw Docker API proxy** — the agent never
  exposes `docker exec`, volume/network management, image pulls, or arbitrary CLI passthrough.
  Container IDs are validated with a strict regex
  (`^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$`) before ever reaching a `spawn()` call, both in the
  Next.js layer (as CUIDs for assignment IDs) and again independently in the agent (as raw
  Docker ID/name strings) — defense in depth, not a single trust boundary.

## 7. Control-plane ↔ node-agent communication

- **Protocol**: plain HTTP (not HTTPS) — acceptable *only* because both control plane and every
  current agent run on the same host, reached via Docker's internal bridge network
  (`web-dashboard_default`) using compose service DNS names (`agent`, `agent-rootless`), never
  over a public or even LAN-routed network path today.
- **Auth**: shared static API key per node (`x-agent-key` header), stored **encrypted at rest**
  in `Node.apiKeyEncrypted` using AES-256-GCM (`server/security/crypto.ts`,
  `NODE_CREDENTIALS_KEY` env var, 32-byte key, unique random IV per encryption, GCM auth tag
  verified on decrypt). Compared on the agent side with `crypto.timingSafeEqual` (constant-time).
- **No mTLS, no request signing, no nonce/replay protection.** A captured `x-agent-key` value
  is valid indefinitely and from any source IP that can reach the agent's port — currently
  mitigated by network isolation (Docker bridge-local) rather than protocol-level defenses.
  **This is the single most important finding for Step 6/7 of the refactor**: the shared-secret
  model is fine for same-host agents but does **not** safely generalize to a real remote node
  over an untrusted network without at minimum requiring TLS and reconsidering replay
  resistance.
- **Timeouts**: `NODE_AGENT_TIMEOUT_MS` (default 5000ms), enforced via `AbortController` on
  every agent call — the control plane never hangs indefinitely on an unresponsive agent.
- **Heartbeat**: not a genuine push/pull heartbeat protocol — `Node.status` and
  `lastHeartbeatAt` are updated as a **side effect** of any `listContainers()` call (i.e.,
  whenever a human loads the containers page). There is no independent periodic health-check
  job; a node with no one viewing its containers can silently go stale in the DB's recorded
  status.

## 8. API routes (current surface)

```
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/admin/overview
GET    /api/admin/users            POST /api/admin/users
PATCH  /api/admin/users/:id
GET    /api/admin/clients          POST /api/admin/clients
PATCH  /api/admin/clients/:id      DELETE /api/admin/clients/:id  (soft: isActive=false)
GET    /api/admin/nodes            POST /api/admin/nodes
PATCH  /api/admin/nodes/:id        DELETE /api/admin/nodes/:id    (soft: isActive=false, status=INACTIVE)
GET    /api/admin/assignments      POST /api/admin/assignments
PATCH  /api/admin/assignments/:id  DELETE /api/admin/assignments/:id  (hard delete)
GET    /api/admin/containers                                          (all-node view, added this session)
POST   /api/admin/containers/:id/action
GET    /api/admin/containers/:id
GET    /api/admin/audit-logs

GET    /api/client/overview
GET    /api/client/containers
GET    /api/client/containers/:id
GET    /api/client/containers/:id/logs
POST   /api/client/containers/:id/action
```

Every route funnels errors through `server/http.ts::fromError`, which normalizes Zod/guard
errors to safe client-facing codes and logs unexpected exceptions server-side only (no stack
traces or internals ever reach the browser).

## 9. Container discovery & action flow

**Discovery** (`server/services/containers.ts`):
- `listContainersForSession(session)` — used by `/api/client/containers` and (legacy)
  `/api/admin/overview`: groups a session's visible `ContainerAssignment` rows by node, calls
  `nodeAgentClient.listContainers(node)` once per distinct node, merges live runtime data
  (status/CPU/memory/ports) onto each assignment by matching `dockerContainerId`.
- `listAllContainersForAdmin()` — added this session for `/api/admin/containers`: queries every
  active `Node`'s agent directly, cross-references against all assignments, returns
  **every container the agent reports**, tagging ones with no matching assignment as
  `clientName: "Unassigned"` with empty `allowedActions` (visible, non-actionable).

**Action** (`runContainerAction`):
1. Re-fetch the `ContainerAssignment` scoped to the caller's tenant (or unscoped for ADMIN).
2. Check `action` is in `assignment.allowedActions`.
3. Call `nodeAgentClient.runAction()` synchronously.
4. Write one `AuditLog` row with the outcome.
5. Return `boolean` straight to the HTTP response.

No queueing, no idempotency key, no protection against two rapid clicks both reaching the agent.

## 10. Audit logging

- Single `AuditLog` table, append-only in practice (no UPDATE/DELETE code path touches it).
- Written synchronously, inline, by the route/service performing the mutation — not via an
  event bus or outbox pattern. If the audit write itself throws, the surrounding route handler
  would surface a 500 (though in practice this has never been observed; Postgres writes to a
  simple table essentially never fail in this deployment).
- Captures: actor (user id/email/role, nullable for PAM-auth-failure-before-provisioning
  cases), action string (e.g. `CONTAINER_RESTART`, `USER_CREATE`), target type/id, arbitrary
  JSON metadata, result enum, source IP (from `X-Forwarded-For`, unauthenticated/unverified —
  trusts the reverse proxy, which in this deployment is Next.js itself, not a hardened edge
  proxy stripping client-supplied headers).

## 11. Deployment architecture

- **Host**: single Debian VPS (`vmi2804346`), Docker Compose project `web-dashboard`
  (`/opt/web-dashboard/web-dashboard/docker-compose.yml`).
- **Containers**: `web-dashboard-web-1` (Next.js standalone build), `web-dashboard-postgres-1`
  (Postgres 16), `web-dashboard-agent-1` (rootful Docker agent), `web-dashboard-agent-rootless-1`
  (lenel-rootless Docker agent).
- **Network**: single default bridge network `web-dashboard_default`
  (`172.28.0.0/16`); no network segmentation between the web app and either agent today (both
  agents are reachable by container DNS name from the web container and vice versa — the web
  app is the only thing that actually calls them, but nothing at the Docker-network layer
  prevents an agent from being reached by anything else on that bridge).
- **Exposure**: the web app publishes host port `1337`, firewalled (iptables, default-DROP
  policy) to two private mesh networks only — a self-hosted WireGuard mesh and a NordVPN
  Meshnet — never the public internet. Neither agent publishes a host port; they're reachable
  only via the internal Docker bridge.
- **Reverse proxy**: none in front of HostPanel specifically (unlike most other services on
  this host, which sit behind Nginx Proxy Manager) — deliberate, since this is mesh-only.
- **Image builds**: `docker compose build <service>` on the host directly from the git working
  tree — there is no CI pipeline; every deploy is a manual build+up cycle run by whoever is
  operating the host.
- **Source control**: `github.com/reneberkmann99/web-dashboard`, single `main` branch, direct
  pushes (no PR/review workflow, no CI checks gating merges).

## 12. Secrets & configuration handling

All configuration is environment variables, supplied via `/opt/web-dashboard/web-dashboard/.env`
(mode 600) and threaded into each compose service's `environment:` block individually (Compose
does not auto-inject `.env` into containers beyond variable *substitution* in the compose file
itself — every var that needs to reach a container is explicitly re-declared in that service's
`environment:` map, which has already caused at least one real incident this session: a stale
placeholder value silently shipped instead of the intended secret because a `sed` replacement
targeted the wrong file).

| Secret | Purpose | At-rest protection |
|---|---|---|
| `DB_PASSWORD` | Postgres auth | None (plain env var; standard for same-host DB) |
| `NODE_CREDENTIALS_KEY` | AES-256-GCM key for `Node.apiKeyEncrypted` | Root-only `.env` file perms; this key itself has no rotation mechanism today — rotating it would silently break decryption of every already-stored node API key |
| `AGENT_API_KEY` / `AGENT_ROOTLESS_API_KEY` | Per-agent shared secret | Encrypted at rest in DB (see above); plaintext in `.env` and container env |
| `PAM_BRIDGE_KEY` | Bridge auth | Plaintext in `.env` + mirrored at `/etc/hostpanel-pam/key` (host, root, mode 600) |
| `COOKIE_SECURE`, `PAM_ADMIN_USERS`, `SESSION_TTL_HOURS`, etc. | Non-secret config | N/A |

No secrets manager, no Vault, no sops — a deliberate simplicity tradeoff already documented
elsewhere on this host's infrastructure wiki, consistent across all services, not unique to
HostPanel.

## 13. Tests

**None exist for the application today.** `tests/example.spec.ts` is unmodified Playwright
boilerplate (asserts against `playwright.dev`, the framework's own marketing site) — it does
not exercise HostPanel at all. `playwright.config.ts` is present but no HostPanel-specific
spec has ever been written. This is the most significant gap the refactor must close (Step 9).

## 14. Summary of what Step 2 onward must address

| Finding | Refactor step |
|---|---|
| No real Project/Stack grouping despite schema scaffolding | Step 2 |
| ContainerAssignment conflates identity + grant; forces manual container-ID entry | Step 2, Step 2 (UI) |
| Only 2 flat roles | Step 4 |
| Demo/default passwords in seed + UI placeholder text | Step 3 |
| No invite/activation flow | Step 3 |
| No login rate limiting on the main app | Step 3 |
| Synchronous container actions, no operation lifecycle, no double-click protection | Step 5 |
| Shared static agent key, no mTLS/replay protection (documented, not yet re-architected) | Step 6 |
| Manual node enrollment (paste name/hostname/URL/key) | Step 7 |
| No DB constraints preventing CLIENT-without-client, orphaned assignments, etc. | Step 8 |
| Zero application tests | Step 9 |

---

# Post-refactor state (2026-08-18) — production foundation

The sections above document the pre-refactor baseline. This section records what
the production-foundation refactor changed and the architecture as it stands now.
Everything below is deployed and verified in production (commits `79e1c50`,
`0ea2ed8`, `f5131f2` on `main`).

## Domain model (current)

```
ClientAccount — tenant (name, slug, isActive)
  1—* User (role: ADMIN | CLIENT_ADMIN | CLIENT_OPERATOR | CLIENT_VIEWER)
  1—* Project          — logical stack (Home Assistant, Mailcow, BookStack, …)
  1—* AccessGrant      — unified grant (project-level or container-level)
  1—* Operation        — async action records

Node — Docker daemon under control-plane management
  1—* Container        — discovered inventory (nodeId+dockerContainerId unique)
  1—* AccessGrant / Operation / Project / ContainerAssignment (legacy)

AccessGrant — exactly one target: projectId XOR containerId
  - unique (clientAccountId, projectId) and (clientAccountId, containerId)
  - allowedActions[] per grant (start/stop/restart/view_logs)

ContainerAssignment — legacy pre-refactor grant, retained; its rows were
  backfilled into Container + AccessGrant and both id spaces resolve in the
  client APIs (aliasIds), so old URLs keep working.

Operation — container actions are now asynchronous:
  REQUESTED → QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLED
  - partial unique index: at most one active operation per docker container
  - recovery sweeper (instrumentation.ts) resumes stale ops after restart
```

## What changed, by concern

| Concern | Before | After |
|---|---|---|
| Container access | hand-typed docker IDs into ContainerAssignment | admin picks from agent-discovered inventory (Container rows); grants reference discovered objects |
| Stacks | Project table existed, 0 rows, no routes | full CRUD API + UI; containers attach via Container.projectId |
| Roles | ADMIN / CLIENT (flat) | 4 roles with a capability matrix (`server/auth/policy.ts`); node.manage never granted to client roles |
| Container actions | synchronous HTTP→docker | Operation lifecycle + polling UI + conflict 409 + recovery sweeper |
| User creation | admin set password (UI defaulted to `ClientPass123!`) | invite → pending user → one-time activation token (72h) → user sets own password; URL shown once |
| Login brute force | none | fixed-window rate limiter (10/15min per IP+identifier) |
| CSRF | none (SameSite=Lax only) | double-submit cookie `hostpanel_csrf` + `X-CSRF-Token` header, enforced in middleware for all mutating /api routes |
| Node registration | admin pasted API URL + invented key | enrollment tokens (15 min, single-use, hashed at rest); agent self-registers and receives a generated key; key persisted to AGENT_KEY_FILE |
| Node metadata | name/hostname/url only | agent /info → version, docker version, OS, CPU, RAM, heartbeat (captured on every inventory listing) |
| Data consistency | CLIENT users could lose their client link (observed in prod) | DB CHECK (client roles require clientAccountId) + route-level invariant; stale containers marked inactive (never deleted); deactivated clients lose visibility immediately |

## Secrets & key handling (current)

- Node API keys: AES-256-GCM at rest (`Node.apiKeyEncrypted`), key from
  `NODE_CREDENTIALS_KEY` (64-hex). Rotation = re-enroll with a fresh token
  (endpoint rotates the stored key; old key stops working immediately).
- Enrollment tokens: sha256-hashed at rest, 15-min TTL, single-use.
- Activation tokens: sha256-hashed at rest, 72-h TTL, single-use.
- Passwords: bcryptjs cost 12; never displayed; PAM accounts use sentinel
  `PAM_MANAGED` and re-verify via the host PAM bridge on every login.
- No custom cryptography anywhere — node crypto + bcryptjs + AES-GCM only.

## Known limitations after this phase

1. **CSRF cookie is non-HttpOnly by design** (double-submit pattern). If the
   mesh-only deployment is ever exposed publicly behind a proxy that does not
   set `COOKIE_SECURE=true`, this should be revisited (see middleware.ts).
2. **Login rate limiter is in-memory** — resets on process restart; adequate
   for the single-instance control plane, not for a horizontally scaled one.
3. **Operation executor is in-process** (fire-and-forget + sweeper). A
   multi-instance deployment would need a shared queue (DB-backed claim) —
   the Operation row + partial unique index already give the needed
   primitives.
4. **Agent↔control-plane transport is plain HTTP** on the internal Docker
   bridge. Safe for same-host agents; a genuinely remote node requires TLS
   (see SECURITY-REVIEW.md §6).
5. **`docker ps` short-ID identity** is used for containers; long IDs would be
   more collision-resistant but short IDs are unique per daemon and stable for
   the lifetime of a container.

## Tests (current)

33 automated tests (`npm test`, vitest, isolated `hostpanel_test` database):
auth, tenant isolation (incl. cross-tenant ID-swap negative tests),
authorization matrix, operation lifecycle + conflict, node enrollment,
consistency guards. See `tests/`.

---

# Phase 3 (2026-08-19) — Operations completeness / daily-driver UX

This section records what the Phase 3 feature pass added on top of the
Production-foundation refactor above. Everything below is deployed and
verified against the live control plane (commits from `feat: global search`
through `fix: throttle Compose reconciliation` on `main`); test count is now
**66/66 passing**.

## New domain model additions

```
Project.source            ProjectSource (MANUAL | COMPOSE), default MANUAL
Project.composeProject    Docker Compose project name (COMPOSE projects only)
                           unique per (nodeId, composeProject)
Container.composeProject  com.docker.compose.project label, recorded on every
Container.composeService  inventory refresh regardless of workload adoption
```

## New services

| Service | Responsibility |
|---|---|
| `server/services/search.ts` | Global search: `searchForAdmin` (platform-wide), `searchForClient` (grant-scoped, workloads+containers only) |
| `server/services/client-team.ts` | CLIENT_ADMIN team management, hard-scoped to `session.clientAccountId`; invite/reissue/deactivate for operator/viewer roles only |
| `server/services/compose.ts` | Compose label recording, workload reconciliation (`reconcileComposeWorkloads`), throttled combined pass (`reconcileComposeIfDue`), discovery listing, adoption |
| `server/services/logs-stream.ts` | Agent SSE relay for live logs (`agentLogsToSSE`) |

`server/services/containers.ts` gained `queryAllContainersForAdmin` (server-side
search/filter/sort/paginate over the live-gathered inventory) and
`resolveLogTarget` (DB-only log-stream authorization, no agent round-trip).
`server/services/workloads.ts` gained `restartWorkload` (batch Operation
requests, partial-failure-aware).

## New API surface

```
GET    /api/admin/search                       GET  /api/client/search
GET    /api/client/team          POST /api/client/team
PATCH  /api/client/team/:id      POST /api/client/team/:id   (reinvite)
GET    /api/client/activity
GET    /api/admin/containers/direct/:nodeId/:dockerId/logs/stream   (SSE, admin)
GET    /api/client/containers/:id/logs/stream                       (SSE, client, view_logs-gated)
GET    /api/admin/compose/discovered            POST /api/admin/compose/adopt
POST   /api/admin/workloads/:id/restart
```

`GET /api/admin/containers`, `/api/admin/audit-logs`, and `/api/admin/clients`
now accept `search/status/nodeId/clientId/sort/dir/page/limit`-style query
parameters and return `{ data, total, page, limit, pageCount }` instead of the
full table.

## Node agent surface additions

```
GET  /containers/:id/logs/stream    -- docker logs --follow --timestamps, raw stream
GET  /storage                       -- docker system df, structured summary
```

Both are additive to the existing curated, whitelisted agent surface (no new
Docker API exposure, no shell/exec). `DockerAdapter` interface gained
`streamContainerLogs()` and optional `getStorageSummary()`.

## Compose reconciliation semantics

- Runs on every inventory refresh, throttled to once per 30 seconds per node
  (in-process `Map<nodeId, lastRunAt>` in `compose.ts`) — added after browser
  smoke-testing showed the unthrottled version added 4-6s to every dashboard
  poll on hosts with 30+ containers (per-container upserts on every request).
- Only runs when the agent actually reported an online inventory (same guard
  pattern as the existing stale-container sweep) — an offline/timed-out agent
  can never trigger a reconcile or a deactivation.
- Recreated containers (new Docker id, same `com.docker.compose.service`
  label) are re-associated to the existing workload; the stale row is marked
  `isActive=false`, never deleted.
- MANUAL workloads are never touched by this path — the reconciler only
  iterates `Project` rows with `source=COMPOSE`.
- Grants remain project-level, so ordinary container recreation never disturbs
  tenant access (verified in `tests/compose-reconcile.test.ts`).

## Live logs transport

```
Browser --(SSE, credentials:include)--> Next.js route handler
  --(authz: grant + view_logs, DB-only, no agent call)-->
  --(plain HTTP fetch, streamed body)--> node agent
  --(docker logs --tail N --follow --timestamps)--> Docker daemon
```

The browser never holds a direct connection to the agent. Stream teardown is
symmetric: browser disconnect → `AbortController` on the client fetch →
`ReadableStream.cancel()` on the SSE relay → `agentStream.cancel()` → agent's
Express response `close` event → `child.kill("SIGTERM")` on the underlying
`docker logs` process. No control-plane-side unbounded buffering: lines are
relayed as they arrive, never accumulated server-side.

## Known limitations after this phase

1. **Compose reconciliation latency**: throttled to 30s/node, so a Compose
   `up`/recreate can take up to that long to be correctly re-attributed on
   dashboards. Deliberate trade-off, not a bug — see UX-NOTES.md.
2. **No adoption UI** for discovered Compose projects yet; adoption is
   API-only (`POST /api/admin/compose/adopt`).
3. **SSE log streams have no server-side byte/line cap** beyond the agent's
   own tail+follow; the browser bounds its own buffer at 5000 lines. Fine at
   current concurrency; revisit before wider adoption.
4. **Workload restart is sequential-request, not truly parallel-optimized** —
   each container's `CONTAINER_RESTART` operation is requested in a loop and
   executes via the existing fire-and-forget executor; at very large workload
   sizes (dozens of containers) this could be batched, but no workload in
   production today is large enough to justify it.

## Tests (current, Phase 3)

**66 automated tests** (`npm test`, vitest, isolated `hostpanel_test`
database) — 33 from the production-foundation phase plus:

- `tests/search.test.ts` (6) — admin search coverage, client tenant isolation,
  grant scoping, href correctness
- `tests/client-team.test.ts` (9) — CLIENT_ADMIN scoping, elevation
  prevention, self-deactivation prevention, cross-client denial, non-admin
  role rejection
- `tests/logs.test.ts` (5) — log-stream authorization: grant-with-view_logs,
  grant-without-view_logs, cross-tenant denial, non-existent grant
- `tests/containers-query.test.ts` (4) — pagination totals/pageCount,
  status/search filtering
- `tests/compose-reconcile.test.ts` (5) — the five required scenarios:
  container recreation, new service, removed service, manual-workload
  untouched, grant survival
- `tests/workload-restart.test.ts` (3) — 404, all-succeed, partial-failure

---

# Phase 4 (2026-08-19) — Compose adoption, workload topology & product polish

A deliberately constrained phase closing the product gaps around workloads and
discovered Compose projects. **No deployment management was added** (no Compose
YAML/env/secret editors, no `docker compose up/down`, no image workflows) — that
remains a separate product decision. All changes deployed and validated against
the live control plane; test count now **90/90**.

## Domain model changes

```
Project.clientAccountId   now NULLABLE — a workload may be "internal" (no
                          client) until an AccessGrant is explicitly created.
                          Ownership/ACL is ALWAYS resolved through AccessGrant,
                          never inferred from this column.
Project unique constraint  (nodeId, slug) replaces (clientAccountId, slug) —
                          slug uniqueness is node-scoped so internal workloads
                          participate; CASCADE → SET NULL on client delete.
Migration                 20260819110000_project_nullable_client
```

## New services & API surface

| Area | What |
|---|---|
| `compose.ts` | `listDiscoveredComposeProjects` (enriched: services/health/network+volume counts/conflicts/lastObserved), `getDiscoveredComposeProjectDetail`, conflict-aware `adoptComposeProject` (already-adopted / conflict / not-found result union; nullable clientAccountId; `moveConflictingContainers` explicit opt-in), `previewConvertToCompose` (unambiguous-only), `convertToComposeManaged` (in-place field update), `detachComposeTracking` (pure DB: source→MANUAL, composeProject→null — never touches Docker) |
| `workload-resources.ts` | Networks/Volumes aggregation + shared-resource detection; one `listContainers()` + one batched inspect per node (no N+1); CLIENT sessions never receive host bind source paths |
| `logs-stream.ts` | SSE relay hardened: 16 KiB line cap (truncated with marker), 1 MiB pending-buffer cap (drop with marker), backpressure-aware enqueue, teardown via `reader.cancel()` (fixed: cancelling a locked agent stream was a no-op) |

New routes: `GET /api/admin/compose/discovered[/:nodeId/:composeProject]`,
`POST /api/admin/compose/adopt`, `GET /api/admin/workloads/:id/convert-preview`,
`POST /api/admin/workloads/:id/convert`, `POST /api/admin/workloads/:id/detach`,
`GET /api/admin/workloads/:id/resources`,
`GET /api/client/workloads/:id/resources`.

## Agent surface additions

- Per-container `networkNames` + `mountRefs` (name/type/source/destination/
  mode/volumeName) captured during the EXISTING per-container inspect in
  `listContainers()` — zero additional Docker calls per container.
- `POST /networks/inspect` (batch, ≤50 names) and `POST /volumes/inspect`
  (batch, ≤50 names) — `docker network inspect` / `docker volume inspect`
  behind the same sanitization (strict name regex) and auth as everything
  else on the agent. Read-only: no create/delete/connect endpoints exist.

## Adoption / conversion / detach semantics

- **Adoption** creates a COMPOSE workload (id/slug unique per node; slug
  auto-suffixed on collision with a stale detached remnant). Containers are
  associated in the same transaction flow; conflicts (containers already in
  another workload) BLOCK adoption with a structured 409 unless the caller
  passes `moveConflictingContainers: true`.
- **Conversion** (MANUAL → COMPOSE) is in-place: id, friendly name, client,
  grants and activity history are retained (plain `source`/`composeProject`
  update). Only offered when unambiguous: every active member carries the same
  compose label, no non-compose members, the compose project isn't adopted
  elsewhere, and membership is already the full live set.
- **Detach** converts COMPOSE → MANUAL with current active members as static
  membership. Pure DB update — never stops/deletes containers, volumes,
  networks, and never runs `docker compose down`. Future inventory refreshes
  simply stop re-syncing membership (reconciler iterates `source: COMPOSE`
  only). Grants and history untouched.

## Shared-resource awareness

Networks/volumes are marked `exclusive` or `shared_with_others` (with the
count of containers outside the workload that also use them). Detection is
computed from the same live inventory snapshot used for rendering — no extra
Docker calls — so it's groundwork for future deployment/update workflows, per
the brief ("do not assume resources named after a Compose project are safe to
delete").

## SSE limits (documented)

Line cap 16 KiB (oversized lines truncated + `[log line truncated]`), pending
buffer cap 1 MiB (excess dropped + `[buffer dropped]`), bounded per-frame
enqueue with backpressure polling, agent stream teardown on browser
disconnect / error / end. Normal continuous streams are never terminated on
total byte count — only per-event and in-flight buffering are bounded.

## Accessibility & polish

- `useFocusTrap` hook (Tab/Shift+Tab cycling, focus restore) wired into
  `Modal` and the command palette.
- `TabBar` component: ARIA tablist/tab roles, arrow-key/Home/End navigation,
  `aria-selected`; swapped into workload/node/client detail pages.
- Fixed React #418 hydration mismatch (header clock rendered server-UTC vs
  browser-local) by making the timestamp client-only.
- Null-client rendering hardened across node detail / workload views.

## Known limitations after Phase 4

1. **Compose reconciliation remains throttled (30s/node)** — unchanged from
   Phase 3; a recreated container can take up to 30s to re-appear correctly
   attributed. Deliberate trade-off.
2. **No Compose project rename / label-drift handling** — if a project's
   containers are relabelled to a different compose project name, HostPanel
   treats it as removal + new discovery (no silent merging across names).
3. **Adoption wizard is single-admin, no bulk adoption.**
4. **Client workload detail still derives containers via name-matching**
   (pre-existing); the resources endpoints are properly grant-scoped, but the
   containers tab's membership logic predates Phase 4 and should eventually
   use project-scoped resolution like the admin side.
5. **No deployment management by design** — explicitly out of scope; the next
   product decision is whether HostPanel stays an operations-only control
   plane or becomes a deploy/update platform.

## Tests (current, Phase 4)

**90 automated tests** — 66 from Phase 3 plus:

- `tests/compose-adoption.test.ts` (13) — adoption (client / internal),
  double-adoption, cross-node identity, conflict refusal + explicit move,
  re-adopt-after-detach slug uniqueness, conversion (safe/ambiguous/
  already-adopted/incomplete) with id+grant retention, detach semantics
- `tests/workload-resources.test.ts` (7) — network aggregation, shared
  network/volume detection, bind mounts, CLIENT host-path withholding,
  grant-scoped visibility
- `tests/logs-limits.test.ts` (4) — oversized line truncation, pending-buffer
  bound under newline-free flood, disconnect teardown (caught the locked-
  stream cancel bug), graceful stream end

---

# Managed Compose deployment — Phase 6A foundation + Phase 6B execution engine (IMPLEMENTED)

Phase 6A (foundation) and Phase 6B (execution engine) are implemented and tested (176 tests,
`npm run build` clean). Phase 6B added the runtime-release model (`DeploymentRelease` + image/secret
snapshots), a non-mutating plan engine with stale-plan protection, HMAC request signing/replay
protection, a secure-transport execution gate, and the curated agent execution API
(`prepare/pull/apply/verify/abort` via `docker compose` v2). The execution engine is **implemented
but fleet-wide execution remains DENIED** — no production node has `TLS_VERIFIED` transport yet, so
the execution gate keeps `LEGACY_HTTP` nodes deploy-ineligible (see ADR-0010). Rollback is
ADMIN-triggered, configuration-only, and creates a new `DeploymentRelease`.

Mailcow remains an `EXTERNAL_COMPOSE` workload (no `Deployment`), and no observed workload was
mutated across 6A+6B (verified by before/after `docker ps`/`network ls`/`volume ls` diff).

Design package (all under `docs/`) and ADRs 0001–0010 are **Accepted**:

- `docs/MANAGED-COMPOSE-ARCHITECTURE.md` — full technical design.
- `docs/MANAGED-COMPOSE-DATA-MODEL.md` — Prisma schema (migrations `managed_deployment_foundation`, `managed_release_model`, `node_compose_capability`).
- `docs/MANAGED-COMPOSE-API.md` — REST + agent contract.
- `docs/MANAGED-COMPOSE-THREAT-MODEL.md` — deployment-specific threat model.
- `docs/MANAGED-COMPOSE-IMPLEMENTATION-PLAN.md` — implementation phases + dependency order.
- `docs/adr/0001…0010` — architecture decision records.

The key decision (unchanged from Phase 5): ownership is a **separate, optional `Deployment` relation
on `Project`**. Modes are *derived*: `MANUAL`, `EXTERNAL_COMPOSE` (Mailcow), `MANAGED_COMPOSE` (a
`Deployment` exists). Revisions are immutable; secrets are versioned, encrypted at rest, referenced
by key only; rollback re-applies a previous revision and never restores data or secret values;
HostPanel never auto-deletes volumes/networks and never auto-rolls-back.

---

# Phase 6D — fleet operations attention model (2026-08-20)

Phase 6D adds a reusable operational domain concept: an active condition that
currently requires attention. The backend derives it once; Overview, Nodes,
Workloads, Containers, resource detail pages, tenant dashboards, Activity, and
future notification consumers read the same state. React components do not
reinterpret Docker state independently.

## Health terminology and severity

The UI keeps three axes separate:

- **runtime/connectivity**: `RUNNING`, `STOPPED`, `STARTING`, `STOPPING`,
  `OFFLINE`;
- **health/reconciliation**: `HEALTHY`, `UNHEALTHY`, `PENDING`, `DEGRADED`,
  `DRIFTED`, `UNKNOWN`;
- **attention**: `CRITICAL`, `WARNING`, `INFO`, or no active condition
  (`HEALTHY`).

A container can be `RUNNING` + `UNHEALTHY` + `WARNING`; a managed workload can
be `CONVERGED` + `DEGRADED` + `WARNING`. `UNKNOWN` is never promoted to healthy,
and `DEGRADED` is never relabelled `DRIFTED`.

## Persisted condition lifecycle

`AttentionState` is unique by resource + condition type and records
`firstObservedAt`, `lastObservedAt`, and `resolvedAt`. Repeated polls refresh an
open row; they do not create alert spam. Opening and resolution produce one
`ATTENTION_OPENED_*` / `ATTENTION_RESOLVED_*` operational Activity transition.
Audit records remain append-only. A resolved row is reused if the condition
reopens; this is a lightweight active-condition model, not full incident
history.

Persisted lightweight observations support `ContainerRestartSample`
(cumulative changes, retained 24h) and `NodeResourceSample` (at most once/min,
retained 24h). Per-container CPU/memory uses a bounded in-memory consecutive
sample map—no timer or database row per container.

## Conditions and thresholds

- heartbeat: `STALE` after 90s, `OFFLINE` after 5m;
- crash loop: warning at 3 and critical at 8 restarts inside 10m; successful
  deployment/restart operations suppress expected restarts for 3m;
- node pressure: at least 3 samples across 5m; CPU 85/97%, RAM 85/95%, disk
  85/95% (warning/critical);
- container pressure: 3 consecutive observations; CPU warning 90%; memory
  warning 90% and critical 98% of the Docker limit;
- stuck operation: container 5m, managed deployment 15m;
- recent failures: significant failures in the last 24h.

Every threshold lives in `server/services/attention-config.ts` and is
environment-overridable; the frontend contains no numeric alert thresholds.

## Deduplication and tenant scope

Overview suppresses children under their useful root cause: an offline node
suppresses its container/workload issues, and a workload condition groups
actionable member-container conditions. Container detail still exposes its
local state. Client feeds contain only workload conditions reachable through
that tenant's active grants; node infrastructure, other clients, container host
details, and admin deployment internals never enter the client response.

## Polling, realtime, and performance

Fleet inventory is collected concurrently across nodes. A failed poll enters
heartbeat grace instead of immediately flipping offline. Conditions on a
temporarily unreachable-but-not-offline node are preserved because missing
telemetry is not evidence of recovery. Workload Activity is fetched in one
batch instead of once per project. Tables default to stable attention/name
ordering, never changing CPU values unless the operator explicitly sorts CPU.

LogViewer remains explicit-view-only: dashboards create no hidden SSE streams.
Its stable `streamPath`, reconnect tail replacement, pause buffering, resume
reconnect, bounded buffer, visible scrollbar, and compact log font remain
unchanged.

## Known limitations

1. Container pressure state is process-local; after control-plane restart,
   three fresh observations are required before it alerts again.
2. Host disk uses `statfs` on the bind-mounted Unix Docker socket path. TCP
   endpoints or unusual layouts should set `AGENT_HOST_DISK_PATH` to a
   read-only bind mount on the Docker data filesystem.
3. Conditions cannot yet be acknowledged/silenced and no notifier is shipped;
   the stable condition vocabulary is preparation for that future consumer.
4. Client workload-detail membership still uses project-name matching
   (pre-existing debt); authorization remains grant-scoped.

## Qualification

- 279 Vitest unit/integration tests pass across 36 files, including attention
  derivation/lifecycle, tenant isolation, action-response handling, and a
  simulated 20-node / 100-workload / 500-container inventory.
- Six permanent Playwright regressions cover node/client/admin-workload/client-
  workload tab placement and LogViewer polling, pause/resume, interruption,
  reconnect, and duplicate-line behavior.
- Six disposable live operational workflows cover healthy telemetry, node
  offline/recovery with grouped impact, unhealthy/recovery with direct log
  navigation, crash-loop threshold/recovery, managed `DEGRADED` semantics, and
  a failed operation appearing in Recent failures.

# Phase 6E — attention lifecycle, notification delivery and HTTPS

Phase 6E extends (rather than replaces) `AttentionState`. Operator-entered
state lives in separate append-only/policy relations:
`AttentionAcknowledgement`, `AttentionSilence`, and `MaintenanceWindow`.
Logical notification transitions and their individual attempts live in
`NotificationEvent` and `NotificationDelivery`; destinations are global/admin
only and store encrypted URL/auth/signing material. Partial/check constraints
enforce one active acknowledgement and exact scope targets.

Attention sync creates idempotent opened/escalated/resolved events from backend
condition transitions. A database-backed worker performs signed webhook HTTP
outside the poll transaction, persists bounded attempts, recovers pending work
after restart, and exposes pipeline failures without recursively notifying
about them. Silence/maintenance are delivery policy only: health and severity
never change. Expiry/end processing is backend-owned and idempotent.

Browser TLS terminates at a read-only nginx proxy on the existing VPN-only host
port 1337. The Next.js port is Compose-internal. Self-signed material persists
at `/etc/hostpanel/tls`, includes the real WireGuard/Meshnet IP SANs, and is
never regenerated at container startup. SSE has explicit no-buffering rules;
secure cookies, proxy-overwritten forwarded headers and HTTPS notification deep
links complete the same-origin HTTPS boundary. See `docs/HTTPS-TLS.md` and
`docs/NOTIFICATIONS.md`.

Host-disk telemetry remains explicit: TCP Docker agents or layouts where the
socket path is not on the host data filesystem must bind the Docker data
filesystem read-only and set `AGENT_HOST_DISK_PATH`. Missing telemetry is
reported UNKNOWN/unavailable, never healthy.
