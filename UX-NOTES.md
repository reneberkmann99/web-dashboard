# HostPanel — Operations UX (phase notes)

Screen-by-screen description of the operations-focused interface, and the UX
debt that remains after this phase. Companion to `ARCHITECTURE.md`.

## Navigation

Primary sidebar (admin): **Overview · Workloads · Nodes · Clients · Activity**,
with a **Settings** group below it (Users, All containers). "Assignments",
"Users" and "Audit logs" are no longer primary destinations — access grants are
managed from the workload or client context, users live under the client they
belong to, and audit is presented as Activity.

Client sidebar: **Overview · Workloads · Containers**.

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

## Remaining UX debt

1. **No global search.** Search exists per table (workloads, nodes, clients,
   containers, activity) but there is no cross-resource command palette; an
   admin still has to pick the right screen first.
2. **Workload detail lacks Networks and Volumes tabs.** The data is available
   per container, but is not yet aggregated to stack level.
3. **Logs are polled, not streamed.** Refresh is every 10 s with a manual tail
   selector; there is no follow/live mode (needs SSE or WebSocket support in
   the agent).
4. **Client-side users management.** `CLIENT_ADMIN` has the capability in the
   policy layer, but no client-facing user-management screen exists yet;
   invitations are admin-only in the UI.
5. **Row action menus.** Actions are inline buttons on most tables; the brief
   asks for overflow/context menus once the action count grows.
6. **No bulk operations.** Restarting several containers means visiting each.
7. **Node detail Configuration tab** is not implemented (deliberately, since
   credentials must not be displayed) — it currently has no non-secret content
   worth a tab.
8. **Attention items are not dismissible** and have no "acknowledge" state, so
   a known-stopped container keeps appearing as informational noise.
9. **Pagination is client-side.** All rows are fetched then paged in the
   browser; at several thousand containers this needs server-side paging or
   virtualization.
10. **Empty-state coverage is uneven.** Tables have good empty states; some
    detail-tab panels still fall back to a plain sentence.
11. **Accessibility passes are partial.** Dialogs, focus rings, labels and
    semantic buttons are in place; a full keyboard-only and screen-reader audit
    has not been performed, and tab bars are not yet wired as ARIA tablists.
12. **Workload creation is still form-first** (inside the grants page) rather
    than a guided flow, and containers are attached to stacks by database
    linkage rather than through the UI.
