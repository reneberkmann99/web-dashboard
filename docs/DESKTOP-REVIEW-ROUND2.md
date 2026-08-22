# Desktop Review — Round 2 Coverage

Source: `DESIGN REVIEW · ROUND 2 · PLATFORM.NODERAFT.EE · 22 AUG 2026` ("The shell is fixed. The data layer isn't.")

Status legend: **Implemented** (code changed this round) · **Verified** (already correct, checked against the review's exact claim) · **N/A** (doesn't apply, with reason).

## P0 — New defects

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Ghost row bleeds through sticky "TODAY" header | **Implemented** | Root cause: `overflow-hidden` on Activity's `<ol>` made it its own CSS scroll container, so the sticky day header's `top:52px` resolved against *that* box instead of the page, pushing the header ~52px past its natural position and overlapping the row above. Fixed with `md:overflow-visible` (`components/activity/activity-timeline.tsx`) plus an opaque (non-`/95`, no `backdrop-blur`) sticky background. Confirmed via live DOM inspection (`getBoundingClientRect`) before/after. Same opaque-background fix applied to `DataTable`/`ServerDataTable` sticky `<thead>`, which were not affected by the containment bug (their wrapper already had `md:overflow-x-visible`) but shared the translucent-background risk. |
| 2 | `/account` breadcrumb/sidebar reads "Overview" | **Implemented** | `deriveFallback()` had no `/account` rule, so it silently fell back to the index route context. Added an explicit `/account` case (`components/navigation/navigation-context.tsx`): `rootHref` is `/account` (matches no sidebar item → nothing highlights), breadcrumb reads `{displayName} › Account settings`, and it's never restored from a stale stored trail. |
| 3 | Raw system values reaching the UI | **Implemented** | (a) `docker "29.6.2"` → fixed the agent's version capture (`{{json .ServerVersion}}` → `{{.ServerVersion}}`) plus a defensive `cleanVersion()` strip for already-stored quoted values. (b) `stale · 1070s ago` → `formatAge`/`formatDuration` now humanize (s→m→h, **rounded**, not floored, so 1070s reads "18m" not "17m"). (c) Activity cuids → see §8 below. |
| 4 | CPU/RAM disagree between Overview and Nodes | **Implemented** | Both screens (plus node detail) now read the same `getSustainedNodePressure()` value already used for attention-pressure derivation (a persisted `NodeResourceSample` window average), instead of two independent live per-request polls. Column/card labels say `CPU · 5m avg` / `RAM · 5m avg` (`nodeResourceWindowLabel()`), reflecting the real `ATTENTION_NODE_SUSTAINED_WINDOW_MS`. Confirmed live: Overview and Nodes now show identical 68%/58% for both seeded nodes. |
| 5 | Focus ring stuck on last-clicked nav item | **Implemented** | Repo-wide sweep: every `focus:ring`/`focus:outline-none` pair (29 files) → `focus-visible:`. Sidebar's active-nav tinted fill is unaffected (that's `aria-current`-driven styling, not focus); the persisting cyan box was the mouse-click focus ring, now gated to keyboard-only. |

## §01 Overview

| Item | Status | Notes |
|---|--------|-------|
| Zero attention is a hero panel, not a one-line state | **Implemented** | Collapsed to a 48px strip (dot + "All N nodes and M workloads operating normally" + "Resolved history →") when the unfiltered active set is empty; full list otherwise. |
| Card row proportions (Fleet 1/3, Attention+Operations 2/3 of zeros) | **Implemented** | Removed the separate Attention/Operations `MetricCard`s from the top row — the attention strip and the (already-conditional) Active operations section carry those facts. Fleet card is now full-width. |
| `2/2 · 8/8 · 46/46` always-1 ratio | **Implemented** | `renderRatio()` shows the plain total when numerator===denominator, reveals `num/den` in amber only when they diverge. |
| Main VPS disk bar clipped at card bottom | **Verified** | `ResourceUsage` compact mode uses uniform `space-y-2` between all three bars with no cropping container; not reproduced in this codebase's markup (no `overflow-hidden` on the card). |
| 93% CPU amber but not clickable / not an attention item | **Verified** | Node cards are already full-card links to `/admin/nodes/:id` (bar row included). The "not flagged" half of the complaint is resolved by §P0-4: once CPU/RAM show the real sustained-window value instead of an instantaneous spike, the number and the attention state agree by construction — a genuinely sustained threshold breach still raises `NODE_CPU_PRESSURE` via existing `attention.ts` logic (unchanged, already correct). |
| Delete Workloads/Nodes duplicate sections | **Implemented** | Merged into one "Nodes" section: each node card now also shows its workload count (`{n} workloads`) and container count, computed client-side from the same `workloads` payload the Workloads page uses (no second backend aggregate to disagree with it). |

## §02 Tables, round two

| Item | Status | Notes |
|---|--------|-------|
| Suppress uniform columns, surface as filter chip | **Implemented** | Added generic `omitWhenUniform` to the shared `Column<T>` type (`components/ui/data-table.tsx`, used by both `DataTable` and `ServerDataTable`): hides a column when every visible row shares one value, reappears the moment a second value is present. Applied to Node/Organization (Containers, Workloads) and Health (Workloads, merged with Attention — see below). Confirmed live: with 2 distinct nodes, Node/Org columns show; with all containers unassigned to an org, Organization collapses automatically. |
| Merge State + Health into one status cell | **Implemented** | `StatusBadge` now takes an optional `health` prop and renders it as a second dot inside the state chip; Containers' separate Health column removed. |
| Rows at 44px, not ~66px | **Verified** | `DataTable`/`ServerDataTable` already use `h-11` (44px) rows — this was already fixed in this codebase prior to round 2; the review's screenshot predates it. |
| Pagination parity (Containers had none) | **Verified** | `ServerDataTable` already renders `<Pagination>` unconditionally; Containers uses it. Confirmed live (`1–25 of 27`-style footer visible on Activity and Containers). |
| Sticky header parity at `top:52px` | **Implemented/Verified** | Position was already correct; opacity bug fixed (see P0-1). |
| Bulk-select parity (Workloads had none) | **Implemented** | Added the same checkbox column + bulk action bar pattern as Containers to Workloads, with a bulk "Restart N" action (`Promise.allSettled` over `restartMutation`). |
| Group the Compose noise (`Group by workload`) | **Implemented** | See §Containers below. |
| Number formatting (unit per column, not per row) | **Implemented** | `formatBytesColumn()` picks one unit (B/K/M/G/T) from the visible set's max value and formats every row in it — applied to Containers' and Workloads' Memory columns and the grouped-container summary row. |

## §03 Activity

| Item | Status | Notes |
|---|--------|-------|
| Resolve every id to its display name | **Implemented** | New `server/services/activity.ts` (`resolveActivityTargetLabels`) resolves NODE/CONTAINER/PROJECT/CLIENT/USER target ids to live names, shared by the Activity route and Overview's recent-activity slice (previously two separate, drifting implementations). Handles the two different CONTAINER id shapes in the wild: a plain `Container.id` cuid (lifecycle actions) and the `nodeId:dockerContainerId` composite attention-derived rows actually use — a real bug this round's own testing caught (see Tests). Raw ids never render in the primary row; full id + type is in the row's `Copy ID` / detail modal. |
| `Name (deleted)` for hard-deleted resources | **Implemented** | Node/Container/Organization are never hard-deleted (deactivated only) — a lookup miss there is never labeled "(deleted)". Workload and User rows *can* be hard-deleted; for those, a miss falls back to the metadata name snapshot every delete path already writes, with `deleted: true`. |
| Pair open/close events into one incident row | **Implemented** | `pairIncidentEvents()` collapses an adjacent `ATTENTION_OPENED_X` + `ATTENTION_RESOLVED_X` pair (same condition, same resource) into one row: "Node recovered after 1m", etc. |
| Actor line wastes 20px on "System" | **Implemented** | System-driven rows show no actor text at all; a real person's row shows `· name` inline next to the resource line. |
| Icons must differentiate by severity | **Implemented** | `eventTone()` maps recovery→green check, offline/crash/opened-issue→red triangle, maintenance→amber wrench, human/neutral→the existing pulse glyph. |
| Time range control (Last hour/24h/7d/Custom) | **Implemented** | `TimeRangeFilter` component, defaults to 24h, custom exposes real start/end `datetime-local` inputs. State lives in the URL (`range`/`from`/`to`) via the existing `syncUrl` pattern — shareable, Back/Forward-safe. |

## §04 All Users

| Item | Status |
|---|---|
| Standard header (`Users N` + `Invite user`) | **Implemented** |
| Invite form off the landing view, into a side sheet | **Implemented** — moved into `Drawer`, opened from the header button. |
| Status as a chip, not colored text | **Implemented** — green-dot Active / neutral-dot Disabled / amber Pending. |
| `All organizations` dim text instead of `—` | **Implemented** |
| `You` chip for the signed-in user | **Implemented** — compared against `/api/auth/me`. |
| Blank `ACTIONS` column header | **Implemented** |
| Concise role labels (no inline permission paragraph) | **Implemented** — `roleLabel()` in the table; the long description moved to help text under the role select in the invite drawer. |
| Filters: Active / Disabled / Organization | **Implemented** |

## §05 Alerting & Account settings

| Item | Status |
|---|---|
| Two "Add webhook" buttons at once | **Implemented** — header button hidden until a destination exists. |
| Section headings 20px vs 15px/600 + hairline | **Implemented** |
| Merge the two delivery-history empty states | **Implemented** — the whole Delivery history section is hidden when there are neither destinations nor deliveries; the single Destinations empty state reads "No destination configured. 0 events queued." |
| Account: wrong gutter | **Verified** — already uses the shared page container; no per-page override found. |
| Account: Email looks empty (placeholder-grey disabled input) | **Implemented** — label/value row with a Copy button. |
| Account: button placement contradiction | **Implemented** — all three cards' actions now sit bottom-right. |
| Account: password requirements after error, not before | **Implemented** — helper text under New password, shown before submit. |

## §06 Consistency debts

| Item | Status |
|---|---|
| Page container padding/x-offset varies by screen | **Verified** — one shared `<main className="p-gutter">` already wraps every page; no stray `mx-auto`/`max-w-*` override found outside the (out-of-scope) workload-creation wizard. |
| Sidebar shows `0` next to Attention | **Implemented** — hidden at zero, amber pill only when non-zero. |
| Names/counts/labels all cyan (round 1 §10) | **Verified** — audited `text-accent`/`text-brand` usage; every occurrence is a real link, active nav, or in-progress spinner. No table name/metadata cell uses it. |
| Inactive chip has no dot | **Implemented** — new `Badge variant="neutral"` (dot in `#5F7292`/`text-subtle`), applied to every isActive-driven state chip (Organizations, node "disabled", client/team "inactive"). |
| Attention filter bar shown over an all-clear state | **Implemented** — hidden when the unfiltered active set is empty. |
| `stale` is a passive label | **Implemented** — the freshness pill is now a button (click → refetch), with a spinner pulse while fetching. |

## §07 Ship order

Not a separate requirement list — items 1–8 map onto the sections above and are covered accordingly. Item 8 (Group by workload) below.

## Containers — Group by workload

**Implemented.** `components/containers/grouped-containers.tsx` + an `Individual`/`Group by workload` toggle (URL `?view=grouped`) on the Containers page. Grouped mode fetches a larger unpaginated batch (search/filters still applied server-side) and renders collapsible parent rows (`Mailcow · 18 containers · running · memory`) that expand to the individual containers with the same status/memory/attention/actions as the flat table. Selection, bulk actions, and the existing filter bar are unchanged; pagination in grouped mode paginates over *groups*, not rows.

## Data consistency (§16)

- Sidebar/topbar Attention badge and Overview/Attention page counts previously used **two different queries** — the topbar (`/api/shell/summary`) counted every unresolved `AttentionState` row including INFO severity; Overview/Attention used the deduplicated, severity-filtered feed. Fixed by exporting and reusing the same `getDeduplicatedAdminAttentionRows()` in both places. Covered by `tests/round2-consistency.test.ts`.
- CPU/RAM: see P0-4.
- Activity names: see §03; the same resolver backs both Overview's recent-activity slice and the full Activity page.
- Docker/agent version: same `cleanVersion()` helper used everywhere the value is rendered (Nodes list, node detail — both agent and docker version stats).

## Out of scope / not touched

- Client/organization-role Activity (`/organization/activity`) — the round's review screenshots are all `platform.noderaft.ee` admin screens; left as-is (degrades gracefully: no resource line when unresolved, never a raw id in the title).
- Alerting *semantics* (destination model, delivery retry policy) — explicitly out of scope per the review ("Do not redesign Alerting semantics").
- Mobile-specific layouts — not part of this round's brief; verified no regression via 390×844 screenshots (Overview, Containers, Activity).

## Tests

- `tests/desktop-format.test.ts` — extended with freshness humanization (incl. the round/floor distinction), `cleanVersion`, `formatBytesColumn`, `groupContainersByWorkload`, `pairIncidentEvents`, and `activityResourceLabel` deleted-suffix behavior.
- `tests/round2-consistency.test.ts` (new) — shell-summary/Overview/Attention attention-count parity; `resolveActivityTargetLabels` for live nodes/containers, hard-deleted workloads/users, the composite `nodeId:dockerContainerId` container-id shape, and the never-"(deleted)" guarantee for Node/Container.
- Full suite: **448/448 passing** (59 files), plus a clean `next build`.
- Desktop Playwright (`tests/desktop-review.spec.ts` etc.) and the E2E specs require a live Docker agent (`baseURL` a real deployed host per `ARCHITECTURE.md`) unavailable in this sandbox; instead this round was verified via a real running instance (seeded Postgres + a minimal fake-agent HTTP double implementing `/info`/`/containers`/`/storage`) driven with Playwright for the visual QA screenshots below. That process caught two real bugs no unit test would have (see below) before they shipped.

## Bugs caught by visual QA (fixed, not just visual)

1. **Activity request storm / phantom empty state.** `effectiveFrom` for the time-range filter called `Date.now()` inline in the render body, producing a new React Query key (and a refetch) on every render — 50 requests in ~4s on one page load, occasionally rendering "0 of N" even though the API always returned real data. Fixed by memoizing on `[range, customFrom]`.
2. **Container-id shape mismatch in the id→name resolver.** Attention-derived CONTAINER audit rows use `resourceId = "nodeId:dockerContainerId"`, not the `Container.id` cuid that direct lifecycle actions use. The first version of `resolveActivityTargetLabels` only handled the cuid shape, silently mislabeling every attention-derived container event as `(deleted)`. Fixed to resolve both shapes; regression-tested.
3. **The P0-1 sticky/ghost-row bug itself was not fully fixed by the background/z-index change alone** — the actual root cause (`overflow-hidden` making the `<ol>` its own sticky containing block) only surfaced under live DOM inspection, not a static code read.
