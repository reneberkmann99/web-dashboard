# HostPanel — Operations UX (phase notes)

Screen-by-screen description of the operations-focused interface, and the UX
debt that remains after this phase. Companion to `ARCHITECTURE.md`.

## Navigation

Primary sidebar (admin): **Overview · Workloads · Nodes · Clients · Activity**,
with a **Settings** group below it (Users, All containers). "Assignments",
"Users" and "Audit logs" are no longer primary destinations — access grants are
managed from the workload or client context, users live under the client they
belong to, and audit is presented as Activity.

Client sidebar: **Overview · Workloads · Activity**, plus **Team** for
`CLIENT_ADMIN` only. "Containers" as a standalone nav item was removed —
containers are reached through workload detail pages; the deep container list
was fleet-wide administrative furniture the client role doesn't need.

Global search (Ctrl/Cmd+K) is reachable from every dashboard page via the
header button or the hotkey — see "Global search" below.

## Screens

### Overview (`/admin`)
Answers "what requires my attention?".
- Four summary cards: containers running/total (with stopped + unhealthy
  breakdown), average CPU across running containers, memory consumed, and
  nodes online/total with a "needs attention" hint.
- **Needs attention** section, rendered only when non-empty. Sources: offline
  nodes, stale heartbeats (>5 min), unhealthy containers, crash-looping
  containers (restarting or restart count ≥3), stopped containers, failed
  operations in the last 24 h. Each row carries a severity badge and a
  human-readable cause.
- Workload grid (name, node, `running/total containers`, health badge, CPU and
  memory), node grid (state badge, container count, relative heartbeat), and
  the last 12 activity events with humanized labels.
- Auto-refreshes every 20 s.

### Workloads (`/admin/workloads`)
Answers "what applications are running?". Projects/Stacks are the primary
abstraction, not a flat container wall.
- Search plus filters for node, client and health state; sortable columns;
  pagination; sticky header; empty/loading/error states.
- Columns: workload (name + description), node, client, container summary,
  health, resource summary, last relevant event. Secondary columns collapse on
  narrow screens.

### Workload detail (`/admin/workloads/[id]`)
Tabs: **Overview · Containers · Activity**.
- Overview: node, hostname, node state, container counts, aggregate CPU and
  memory, client, exposed ports (deduplicated host-port list), and the list of
  clients holding grants with their permission sets.
- Containers: table of the stack's containers with live status, CPU, memory,
  restart count and ports; row click opens the container detail page.
- Activity: workload-scoped audit events.
- "Grant access" opens a modal: pick client → pick permission level (operate vs
  view-only) → save. No Docker identifiers are typed by hand.

### Container detail (`/admin/containers/[nodeId]/[dockerId]`)
A real detail view, reachable for any discovered container.
- Identity and runtime: friendly name, image, short container ID with a copy
  action, node, uptime, restart count, CPU, memory, restart policy, health,
  created time, stack, client, ports.
- Networks, volumes/mounts and labels, sourced from `docker inspect` via the
  agent.
- **State-aware actions**: running → Restart / Stop; stopped → Start; during an
  in-flight operation all conflicting controls are disabled and the operation
  state is shown; when the node is unreachable actions are disabled with an
  explanation naming the node. Confirmation uses an accessible dialog that
  names the target and states the impact — never `window.confirm`.
- Logs panel: configurable tail (100/200/500), client-side filter, download to
  a text file, and secret masking (`password=`, `token=`, `Bearer …` are
  redacted before display).

### Nodes (`/admin/nodes`)
Answers "where do things run and are those hosts healthy?".
- Table: node (name + hostname), state badge, last heartbeat (relative), agent
  and Docker versions, live container count, and row actions.
- Empty state explains how to begin ("Install the HostPanel agent on your first
  Docker server…") with an inline Add node action.
- **Add node** is a modal wizard: generate a one-time enrollment token → copy
  the ready-made `docker run` command → the agent registers itself. API
  credentials are never displayed or requested.

### Node detail (`/admin/nodes/[id]`)
Tabs: **Overview · Workloads · Containers · Activity**. Overview shows state,
heartbeat, agent/Docker version, OS, architecture, CPU cores and memory.
Offline or stale nodes render a prominent banner with the last heartbeat and a
remediation hint.

### Clients (`/admin/clients`)
Answers "who can access what?".
- Table: client, active users, workloads, containers, state, last activity.
- **Create client** is a modal: name → slug (auto-generated, editable).

### Client detail (`/admin/clients/[id]`)
Tabs: **Overview · Users · Workloads · Permissions · Activity**.
- Users: name/email, role, status (active / pending / PAM), last login, and a
  Deactivate action guarded by a confirmation dialog. **Invite user** issues a
  one-time activation link — administrators never type or see passwords.
- Permissions: effective grants (workload or container target, node,
  permission set) with Revoke.

### Activity (`/admin/activity`)
Audit presented as operations history. Humanized labels
(`CONTAINER_RESTART` → "Restarted container") with the raw event type shown
underneath, actor, result badge, resource type and timestamp. Filters for text
and result. Clicking **Details** opens a modal with the raw action, actor,
role, result, target type/id, source IP, timestamp and the full metadata JSON.

### Client screens
`/client` overview, `/client/workloads` (+ detail) and `/client/containers`
(+ detail). Scoped entirely by grants; the container detail page polls its
operation and shows request → running → succeeded/failed with the failure
reason.

## Global search (Ctrl/Cmd+K)

A command palette reachable from any dashboard page. Server-side, debounced
(250ms), grouped results (Workloads / Containers / Nodes / Clients), fully
keyboard-navigable (↑/↓, Enter, Esc), with loading and empty states.

- **Admin** search spans the whole platform.
- **Client** search is hard-scoped server-side to the caller's grants: it only
  ever returns Workloads and Containers the tenant can already see, and never
  Nodes or Clients — there is no client-role code path that can return another
  tenant's data, verified by `tests/search.test.ts`.
- Selecting a result navigates directly to its detail page.

## Server-side data surfaces

Containers (Settings → All containers), Activity, and Clients now do
search/filter/sort/pagination entirely server-side (`ServerDataTable`
component) — the browser receives one page (default 25 rows) plus
`{ total, page, limit, pageCount }`, not the full table. Filters are reflected
in the URL query string so pages are shareable and browser Back/Forward work
correctly. RBAC/tenant scope is enforced in the query builder before
pagination, never client-side.

## Live container logs

Container logs now stream live via Server-Sent Events: browser → control plane
(`agentLogsToSSE`) → authenticated node agent (`docker logs --follow
--timestamps`). The browser never talks to the agent directly. The
`LogViewer` component provides tail-size selection, pause/resume (buffered up
to 2000 lines while paused), client-side filter, auto-scroll only while
already at the bottom, a live/disconnected indicator, automatic reconnect
(2s backoff), a bounded 5000-line ring buffer, and download of the current
filtered view. Authorization (tenant grant + `view_logs` capability) is
resolved before the stream opens, via a DB-only resolver
(`resolveLogTarget`/`getContainerLogsDirect`) so a denied request never
reaches the agent.

## Client self-service

`CLIENT_ADMIN` now has a dedicated **Team** page
(`server/services/client-team.ts`) to invite operators/viewers, reissue
activation links, and deactivate/reactivate their own client's users — hard
scoped to `session.clientAccountId` in every query. It can never create an
ADMIN or another CLIENT_ADMIN, assign a user to a different client, or
deactivate itself, a platform admin, or a PAM-managed account. Client Activity
is a dedicated page (audit events scoped to the caller's client), and the
client Overview now leads with workload health and recent activity instead of
fleet-wide metrics.

## Compose workload discovery

Docker Compose projects (`com.docker.compose.project`/`service` labels) are
now first-class citizens: `Project.source` is `MANUAL` or `COMPOSE`, and
`Container.composeProject`/`composeService` record the discovered labels on
every inventory refresh (throttled to once per 30s per node — see Known
limitations). `server/services/compose.ts` reconciles COMPOSE workload
membership automatically: recreated containers (new Docker id, same Compose
service) are re-associated, new services are added, removed services are
marked inactive (never deleted), and MANUAL workloads are never touched by
this path. An admin can adopt a detected Compose project
(`GET /api/admin/compose/discovered`, `POST /api/admin/compose/adopt`) as a
COMPOSE-sourced workload; grants stay project-level so ordinary container
recreation never disturbs tenant access.

## Workload operations

Workload detail now shows overall health, running/total containers, CPU/RAM,
a Compose-source badge when applicable, and a banner listing recently
failed/restarting containers. "Restart workload" is a secondary/danger action
behind a `ConfirmDialog` that states the affected container count; it requests
one `CONTAINER_RESTART` Operation per active container (reusing the existing
conflict-protected lifecycle) and reports partial failures explicitly — it
never collapses a partial failure into a false "success" toast.

## Node operations

Node detail now shows a Docker storage summary (`docker system df`: images,
containers, local volumes, build cache — count/active/size/reclaimable) and a
running/stopped/unhealthy container breakdown, alongside the existing
heartbeat/version/host info. No historical monitoring database was added —
current-state only, per scope.

## Shared building blocks

- `DataTable` — search, sortable columns, pagination, sticky header, explicit
  empty/loading/error states, optional row click, and a card fallback below the
  `md` breakpoint instead of a squeezed table.
- `Modal` — focus moved in on open and restored on close, `Escape` and backdrop
  dismiss, `role="dialog"`/`aria-modal`, labelled by its title.
- `ConfirmDialog` — names the target, states the impact, separates Cancel from
  the (optionally destructive) confirm action, surfaces errors inline.
- `lib/format.ts` — relative time, byte formatting, short IDs, secret masking
  and the humanized action map (client-safe, no server imports).

## Feedback and error handling

Ordinary successes use toasts ("Action requested", "Client created",
"Invitation generated"). Failures that need intervention persist in place: the
operation banner keeps the failure reason, tables render an error state, and
the container page explains *why* actions are unavailable. Operation failures
surface the agent's message (for example "Node is disabled or inactive")
instead of a generic "Request failed".

## Validated workflows

1. **Identify → inspect → restart → confirm** — attention item surfaces a
   crash-looping container; detail page shows status and logs; restart returns
   `202` with an operation id; polling shows `RUNNING → SUCCEEDED`; the
   container's uptime resets. ✅
2. **Add client → invite user → grant workload → verify** — client created via
   modal; invite produced a single-use activation link; workload grant applied;
   the activated user signed in and saw exactly the granted workload. ✅
3. **Client isolation** — the demo client saw only its granted workload
   (6 containers) and never the other tenant's stack; requesting another
   tenant's grant id returned `404` on read and `403` on action. ✅
4. **Offline node** — stopping an agent flipped the node to `OFFLINE` within
   one refresh, produced a critical attention item with the last heartbeat, and
   disabled that node's container actions. ✅

## Compose discovery & adoption (Phase 4)

`/admin/compose` ("Discover Compose projects" from the Workloads page) lists
Compose projects detected on enrolled nodes that are not yet adopted as
workloads: compose project name, node, running/total containers, health,
service names, network/volume counts, a "Container conflict" warning when
containers already belong to another HostPanel workload, and last-observed
time. Adopted projects show an "Open workload" shortcut.

"Review & adopt" opens a 3-step wizard:
1. **Project** — detected services + health, conflict warning if any,
   editable workload name (defaults to the Compose project name).
2. **Ownership** — "No client / internal workload" or "assign to existing
   client" (assigning never auto-grants permissions; grants stay in the
   access-grant system).
3. **Review** — explicit will/will-NOT lists (create COMPOSE workload, track
   services, preserve recreation; never restart containers, never modify
   Compose files/env, never create/remove Docker resources), plus a mandatory
   checkbox when containers must move from another workload.

Adoption is conflict-safe: containers already in another workload block it
(409 + structured conflicts) until the admin explicitly opts in. Re-adopting
a previously detached project surfaces the stale remnant as a conflict and
auto-suffixes the slug.

Workload detail gains **Convert to Compose-managed** (shown only when the
mapping is unambiguous — same label on all members, no outside members, full
membership) and **Detach from Compose** (COMPOSE workloads only; explicit
confirmation that no Docker resource is touched; converts to MANUAL with
current members).

## Networks & Volumes tabs (Phase 4)

Workload detail (admin and client) now has read-only **Networks** and
**Volumes** tabs. Networks show driver, scope, internal flag, subnets,
gateways, attached workload containers, and a sharing badge: "Exclusive to
this workload" or "Shared with N other containers" (e.g. mailcow's
`nginx-network` shows it is shared with the nginx-proxy-manager container).
Volumes differentiate named volumes (name, driver, destination, mode, mounted
by) from bind mounts (source → destination, read-only/read-write) and tmpfs.
CLIENT sessions never see host bind source paths — the API returns
"Host path hidden" and the full path is withheld server-side; ADMIN sees the
full source. No create/delete/disconnect actions exist (read-only by design).

## Node Configuration tab (Phase 4)

Populated read-only configuration: node ID, display name, hostname, agent
endpoint, docker context, agent version, enabled state, enrollment mode,
registration time, polling/reconciliation intervals, and a "Generate
re-enrollment token" action (15-min single-use token for agent credential
rotation; reuses the existing enrollment flow).

## Remaining UX debt

Items resolved in Phase 4 (Compose adoption UI + wizard, Networks/Volumes tabs,
convert/detach, node Configuration tab, SSE server-side limits, focus traps,
ARIA tablists, hydration fix) are removed; what's left:

1. **Row action menus.** Actions are inline buttons on most tables; the brief
   asks for overflow/context menus once the action count grows — workload
   detail now has several secondary actions, but most tables are still flat
   button rows.
2. **No bulk operations beyond workload restart.** There is no way to, say,
   stop every container in a workload at once, or bulk-grant multiple clients.
3. **Attention items are not dismissible** and have no "acknowledge" state, so
   a known-stopped container keeps appearing as informational noise.
4. **Empty-state coverage is uneven.** Tables have good empty states; some
   detail-tab panels still fall back to a plain sentence.
5. **Accessibility is improved but not audited end-to-end.** Dialogs now trap
   and restore focus, tab bars are ARIA tablists with arrow-key navigation,
   status is never color-only — but no full screen-reader pass has been run.
6. **Workload creation is still form-first** (inside the grants page) rather
   than a guided flow; the Compose adoption wizard is the guided exception.
7. **Compose reconciliation is throttled (30s/node), not real-time.** A newly
   recreated container can take up to 30s to reappear correctly attributed on
   the dashboard/all-containers views after a Compose `up` — acceptable for
   an operations console, called out explicitly since it's a deliberate
   latency trade-off, not a bug.
8. **No Compose label-drift handling.** If containers are relabelled to a
   different compose project name, HostPanel treats it as removal + new
   discovery; there is no UI to change a workload's composeProject after
   conversion/adoption (detach + re-adopt is the supported path).
9. **Client workload detail containers tab derives membership via
   name-matching** (pre-existing); the Networks/Volumes tabs are properly
   grant-scoped, but the containers tab should eventually use project-scoped
   resolution like the admin side.
10. **Workload detail tabs are not deep-linkable** (no ?tab= URL param), so
    sharing a link to the Networks tab isn't possible yet.

## Phase 6C — Managed deployment lifecycle UI

Full operator UX for HostPanel-managed Compose workloads. Only managed workloads
(source=COMPOSE + Deployment relation) expose the Deployments/Secrets tabs and
the overview deployment card; ordinary Compose and MANUAL workloads are unchanged.

- **Overview card**: runtime state (CONVERGED/DEGRADED/DRIFTED, exact backend
  semantics), current release/revision, actor, outstanding operation, last
  healthy release with rollback action when degraded.
- **Deployments tab**: current state, active configuration (compose source,
  never secrets), release history timeline (CURRENT / LAST HEALTHY / HEALTHY /
  DEGRADED badges — never color-only), release detail (runtime-observed image
  identities, verification verdict, failure reason, rotation detection).
- **Editor workflow** (`/admin/workloads/[id]/deployment/edit`): edit YAML →
  validate (server-side Stage A + B; BLOCKED/HIGH_RISK surfaced, ack gate) →
  save as immutable revision (no Docker mutation) → line diff vs current →
  authoritative plan (KEEP guarantees, secret changes, plan hash in an advanced
  disclosure) → explicit confirm → operation progress → result. Zero-impact
  plans explain that nothing requires mutation and disable deploy.
- **Operation progress**: coarse real stages (Queued/Preparing/Pulling/
  Applying/Verifying/Recording) from actual backend state; polling stops on
  terminal state; network failures show a retrying notice, never an endless
  spinner.
- **DEGRADED result**: FAILED + runtimeConverged renders as "Deployment applied,
  but health verification failed — the new configuration is currently running",
  with last-healthy context and a rollback action. Never a generic failure.
- **Rollback**: GET /rollback-target → plan target revision → confirm with the
  explicit "current secret versions are used, historical values are not
  restored" warning → POST /rollback → new release (never reactivates the old
  one). Editors can deep-link `?rollback=1` from a degraded result.
- **Secrets tab**: metadata-only list (version, rotation time/actor, services
  using the secret from the latest revision canonical), version history, rotate
  flow (new value → affected services → plan → confirm → reconcile deploy).
  Plaintext discarded from frontend state immediately after the rotation call.
- **PLAN_STALE**: 409 renders an explicit "plan is out of date" banner with a
  regenerate action; the stale plan is discarded and confirmation is required
  again. Never auto-deploys the refreshed plan.
- **Concurrency**: an active deployment operation is surfaced on the overview
  card and deployments tab; the backend rejects concurrent deploys
  (DEPLOYMENT_OP_IN_PROGRESS) and the UI surfaces it as a translated message.
- **Errors**: all known lifecycle codes map to human messages; the raw code is
  not shown as a stack trace.

### Managed containers: direct action policy (decision)

Direct start/stop/restart on containers belonging to a managed workload REMAIN
available (emergency recovery needs them). The container detail page shows a
"Managed by HostPanel" banner with workload + release/revision context and a
warning that direct actions are audited but can diverge from the managed
deployment state; operators are pointed at workload-level lifecycle operations
for configuration changes. Actions remain fully audited through Operations and
AuditLog — no silent path was added, and no destructive container/volume/
network operation exists anywhere in the managed flow.

### Remaining debt

- The agent `pull` step still returns `images: []` (cosmetic; release image
  identity comes from runtime verification — never tag-derived).
- Release history pagination is UI-simple (latest 100); the API supports
  limit/offset.
- No releases API for CLIENT roles yet (client view stays grant-scoped status
  metadata only).

### Fix: editor usable before the first deploy (2026-08-19, `b5f10b7`+1)

`DeploymentEditor` previously seeded its compose buffer only from the current
release's revision. A managed workload created through the wizard has revision 1
but no release until the first deploy, so the editor rendered a dead page
(title + "No deployment yet" + nothing). Now the editor falls back to the
latest saved revision when no release exists (empty editor only if there are no
revisions at all), shows proper loading/error+retry states instead of a blank
body, and the first-revision review step says there is nothing to diff against
(plan + deploy still work). Covered by `scripts/ui-verify-first-deploy.mjs`
(live browser qualification: create deployment → edit → validate → save →
plan → deploy → reload via release path).

### Fix: workload Containers tab listed the entire node (2026-08-20, after `469811d`)

`toWorkloadDetail` returned summaries for every live container on the node with
an `inProject` flag, and the Containers tab rendered them all — every workload
looked identical. Stats were already membership-scoped, and the tab's empty
state explicitly says containers are attached via the workload, so the node-wide
dump was never intended. The summaries array is now filtered to the workload's
members (DB `Container.projectId`): COMPOSE workloads sync membership from
compose labels, MANUAL workloads attach explicitly. Node-level views
(`/admin/nodes/[id]`, node containers route) still list everything.
