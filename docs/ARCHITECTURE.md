# HostPanel architecture

## Services

- Next.js web app (control plane)
- PostgreSQL (state + auth + audit)
- Node agent (per host)

## Security boundaries

- Browser never talks to Docker.
- Browser talks to Next.js API only.
- Next.js talks to node agents with API key auth.
- Node credentials are encrypted at rest in DB.
- Session cookie is `httpOnly`, `secure` in production, and server-side validated.

## Runtime flow

1. User authenticates via `/api/auth/login`.
2. Session token hash stored in `Session` table.
3. Client and admin APIs validate session and role server-side.
4. Container APIs load assignments from DB and call node agents.
5. Agent performs whitelisted Docker actions only.
6. All privileged actions are written to `AuditLog`.

## Rootless Docker support

- Agent supports `AGENT_DOCKER_MODE=rootless`.
- Rootless adapter runs `docker` with explicit env forwarding:
  - `DOCKER_HOST`
  - `XDG_RUNTIME_DIR`
- Expected deployment: run agent as the same Linux user that owns rootless Docker socket.
- Adapter abstraction allows swapping to Docker Engine API client later.
