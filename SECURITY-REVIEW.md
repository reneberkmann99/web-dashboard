# HostPanel Node-Agent Security Review

Status: reviewed 2026-08-18 as part of the production-foundation refactor (Step 6).
This document states exactly what the agent can and cannot do, and the
recommendations for hardening before the agent is deployed on genuinely remote
nodes over an untrusted network.

## 1. Exact authority of the node agent

The agent (`agent/src/index.ts`) exposes a **curated, whitelisted surface** — it
is NOT a raw Docker API proxy. Full route inventory:

| Route | Authority | Notes |
|---|---|---|
| `GET /health` | Read-only daemon check + host metadata | Returns nodeOnline, mode, agent version, hostname, OS, CPU count, RAM, docker version |
| `GET /info` | Read-only host/agent metadata | Same as health, no daemon interaction required |
| `GET /containers` | Read-only inventory | `docker ps -a` + `docker stats` + per-container `docker inspect` |
| `GET /containers/:id` | Read-only inspect of one container | |
| `GET /containers/:id/logs?tail=N` | Read-only logs, tail capped 1–500 | |
| `POST /containers/:id/:action` | Mutating, **action whitelist only** | Zod enum: `start` \| `stop` \| `restart` |

**Explicitly NOT exposed**: `docker exec`, image pull/build/remove, volume or
network management, port publishes, secret management, arbitrary CLI
passthrough, container create/remove. There is no code path that ever passes a
user-controlled string into a shell — `spawn("docker", argsArray)` only.

Container IDs are validated twice, independently: in the control plane (as
CUIDs for grant/assignment ids) and again in the agent (regex
`^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$`) before reaching any `spawn()` call.

## 2. Agent authentication

- Shared static API key per node, sent as `x-agent-key`.
- Constant-time comparison (`crypto.timingSafeEqual`) in the agent.
- Two acquisition paths:
  1. **Enrollment** (preferred, Step 7): agent registers itself with the
     control plane using a one-time enrollment token; the control plane
     generates a fresh 64-hex key, stores it **encrypted at rest**, returns it
     **exactly once**; the agent persists it to `AGENT_KEY_FILE` (mode 600).
  2. **Legacy manual**: `AGENT_API_KEY` env var (still supported).

## 3. Per-node credentials & storage

- One key per node (`Node.apiKeyEncrypted`), AES-256-GCM with unique random IV
  per encryption; master key from `NODE_CREDENTIALS_KEY` (32 bytes hex).
- Keys are never returned by any API after enrollment; the admin UI has no
  "show key" path.
- Rotation: issuing a new enrollment token for an existing node rotates the
  stored key in the same transaction that marks the token consumed.

## 4. Replay resistance — GAP (documented, accepted for now)

There is **no request signing, nonce, or timestamp check** on agent API calls.
A captured `x-agent-key` can be replayed indefinitely from any client that can
reach the agent's port. This is mitigated today by:

- network isolation: agents bind inside the Docker bridge, no host port
  published, host firewall default-DROP;
- the control plane is the only caller in practice.

**Not acceptable for a remote node** on an untrusted network. See §8.

## 5. Request authorization / command validation

- Every request must carry the correct key (middleware).
- Actions constrained by Zod enum at the route layer.
- Container id constrained by regex at the route layer.
- Rate limited: 120 requests / 10s (express-rate-limit) as a secondary brake.

## 6. Network exposure & TLS expectations

- Today: plain HTTP, internal Docker bridge only (same host). Acceptable —
  no secret crosses a network boundary that isn't already trusted.
- The agent now honors `CONTROL_PLANE_URL` for enrollment; the control-plane
  enroll endpoint is likewise reachable only on the internal bridge.
- **TLS is not implemented** between control plane and agent. For remote
  nodes this is the first thing to add (see §8).

## 7. Heartbeat & timeout behavior

- Control plane enforces `NODE_AGENT_TIMEOUT_MS` (default 5000) via
  `AbortController` on every call — no hangs.
- Node status/lastHeartbeatAt are refreshed as a side effect of inventory
  listings and the `/info` capture; there is no independent push heartbeat.
  Acceptable for the operator-facing product (state is refreshed whenever the
  UI polls, typically every 7s), documented as a future improvement.

## 8. Recommendations before adding remote nodes

1. **TLS** between control plane and agent (terminate at the agent; the
   control plane should pin the agent's cert or use mutual TLS).
2. **Replay protection**: add a request nonce (HMAC over
   `path|timestamp|nonce` with the shared key) or short-lived signed tokens
   issued by the control plane per call.
3. **Network policy**: Docker network segmentation so the web container is the
   only permitted caller of agent ports (currently they share one bridge).
4. **Credential rotation automation**: a documented, scripted re-enroll flow
   (the primitives exist; the ops runbook does not yet).
5. Consider a dedicated agent binary instead of `tsx` (currently runs
   TypeScript via `npx tsx` — fine for the containerized deployment, but a
   compiled artifact reduces supply-chain surface for remote installs).

None of these block the current same-host, mesh-only deployment.
