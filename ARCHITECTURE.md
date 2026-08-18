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
