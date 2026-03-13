# HostPanel

HostPanel is a full-stack hosting control panel MVP for managing client-assigned Docker workloads through a secure central dashboard.

It is designed as a SaaS-style foundation with clean boundaries between UI, control plane, and node execution.

## What this MVP includes

### Client side
- Secure login/logout
- Access only to assigned containers
- Container visibility:
  - name
  - image
  - status (running/stopped/restarting/unhealthy/unknown)
  - uptime
  - ports
  - created time
  - CPU %
  - memory usage
- Container actions:
  - start
  - stop
  - restart
- Recent logs
- Node online/offline indicator

### Admin side
- Secure login/logout
- Full client management
- Full user management (role + client mapping)
- Full node management
- Container assignment management
- Global container visibility
- Container actions across assignments
- Audit log viewer
- Health/summary dashboard

## Architecture

### Core services
- `Next.js app` (control plane + UI + API)
- `PostgreSQL` (state, sessions, RBAC, audit)
- `Node Agent` (runs on each node, executes Docker actions)

### Security boundary
- Browser never talks to Docker directly.
- Browser -> Next.js API only.
- Next.js -> Node Agent (server-to-server, API key auth).
- Node Agent -> local Docker runtime.

This keeps Docker control server-side and supports rootless deployment models.

## Tech stack

- Next.js (App Router)
- TypeScript
- Tailwind CSS
- shadcn-style component architecture
- Lucide icons
- TanStack Query
- Prisma ORM
- PostgreSQL
- Zod validation
- bcrypt password hashing
- Express (node agent)

## Project structure

- `app/` pages, layouts, route handlers
- `components/` UI + dashboard shell
- `server/` auth, RBAC, services, validation, security helpers
- `prisma/` schema, migrations, seed
- `agent/` secure node agent + Docker adapters
- `docs/` architecture notes

## Data model (high-level)

- `User`
- `ClientAccount`
- `Node`
- `Project`
- `ContainerAssignment`
- `AuditLog`
- `Session`

All major models include timestamps; assignments map node containers to client visibility and allowed actions.

## Auth and RBAC

Roles:
- `ADMIN`
- `CLIENT`

Rules:
- Client APIs are restricted to the caller’s assigned client account.
- Admin APIs require `ADMIN` role.
- Authorization is enforced server-side in route handlers and service logic.

Sessions:
- `httpOnly` cookie
- secure in production
- token hash stored in DB (not raw token)

## Node agent

The agent exposes a constrained API:

- `GET /health`
- `GET /containers`
- `GET /containers/:id`
- `GET /containers/:id/logs`
- `POST /containers/:id/start`
- `POST /containers/:id/stop`
- `POST /containers/:id/restart`

Security properties:
- API key required (`x-agent-key`)
- Input validation on container IDs
- Action whitelist only (`start|stop|restart`)
- No arbitrary command execution endpoint
- Rate limiting enabled

## Rootless Docker support

Agent supports two modes:

- `AGENT_DOCKER_MODE=mock`
- `AGENT_DOCKER_MODE=rootless`

In `rootless` mode, the adapter uses Docker CLI with explicit rootless env support:
- `DOCKER_HOST`
- `XDG_RUNTIME_DIR`

Recommended deployment:
- Run the agent as the same Linux user that owns the rootless Docker daemon/socket.

## Local development

## 1. Copy env file

```bash
cp .env.example .env
```

## 2. Start PostgreSQL

```bash
docker compose up -d
```

## 3. Install dependencies

```bash
npm install
```

## 4. Generate Prisma client + apply migration

```bash
npm run db:generate
npm run db:migrate
```

## 5. Seed demo data

```bash
npm run db:seed
```

## 6. Start node agent

```bash
npm run agent:dev
```

## 7. Start web app

```bash
npm run dev
```

## Convenience script

```bash
npm run setup
```

## Demo credentials

- Admin:
  - email: `admin@hostpanel.local`
  - password: `ChangeMe123!`
- Client:
  - email: `ops@acme-hosting.local`
  - password: `ClientPass123!`
- Client:
  - email: `dev@northstar-labs.local`
  - password: `ClientPass123!`

## Environment variables

See `.env.example` for full list.

Important values:
- `DATABASE_URL`
- `SESSION_TTL_HOURS`
- `NODE_CREDENTIALS_KEY` (64-char hex for AES-256-GCM secret encryption)
- `NODE_AGENT_TIMEOUT_MS`
- `AGENT_PORT`
- `AGENT_API_KEY`
- `AGENT_DOCKER_MODE`
- `DOCKER_HOST`
- `XDG_RUNTIME_DIR`

## API groups

- `/api/auth/*`
- `/api/client/*`
- `/api/admin/*`

All request payloads are validated with Zod and return a consistent envelope:
- success: `{ ok: true, data: ... }`
- failure: `{ ok: false, error: { code, message, details? } }`

## Audit logging

Audit events include:
- actor user id/email/role
- action
- target type/id
- metadata
- result
- source IP (when available)
- timestamp

Logged examples:
- login success/failure
- logout
- container start/stop/restart
- create/update users/clients/nodes/assignments

## Production hardening roadmap

- CSRF token strategy for state-changing browser requests
- MFA and proper reset-password workflow
- session rotation and admin session revocation
- mTLS + key rotation for control-plane <-> agent communication
- secret manager integration for encryption keys
- background heartbeat workers and offline alerting
- SSE/WebSocket upgrades for live telemetry
- advanced anomaly detection and rate controls

## Non-goals in this MVP

Not implemented intentionally:
- billing/payments
- invoicing
- domain registrar integration
- full terminal access
- file manager
- git deployment pipelines
- backup orchestration

The architecture is modular so these can be added later without rewriting core boundaries.
