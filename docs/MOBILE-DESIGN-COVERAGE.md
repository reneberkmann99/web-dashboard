# Noderaft Mobile Design Coverage

Phase: **Noderaft Mobile Design Implementation Gate** (2026-08-21)

Authoritative source: `Noderaft Mobile.dc.html` (supplied design package).
Supporting: `Noderaft Components.dc.html`, `Noderaft Brand.dc.html`, `Noderaft Overview.dc.html`, production defect screenshots (`uploads/IMG_3781..3789.png`).

Reference viewport: **390 × 844**. Mobile breakpoint: `<768px`. Tablet (768–1024) adapts from the desktop layout; phones get the dedicated mobile system.

## Design rules (from the design package header)

| # | Rule | Production implementation | Verification |
|---|------|--------------------------|--------------|
| R1 | Tables become cards below 768px — name on its own line (mono, `word-break: break-all` for long technical names), badges in a row, metrics in one mono strip. No `LABEL:` prefixes, no empty columns. | `DataTable`/`ServerDataTable` gained a `mobileCard` presentation; the old data-label mobile fallback rows were removed. Every inventory page renders the mobile card family below `md`. | mobile.spec + screenshots |
| R2 | Bottom tab bar with exactly five destinations (Overview, Workloads, Nodes, Attention, Activity); Attention carries a badge. Sidebar never becomes a full-page list. | `MobileBottomNav` in the dashboard shell (<768px); attention badge from the live fleet summary. Clients/Users/Notifications/Containers live in the account sheet. | mobile.spec |
| R3 | One `Filters` button with active count opens a sheet — never five stacked selects. | `FilterSheet` shared primitive; Containers/Workloads/Attention/Activity use it; desktop keeps its selects. | mobile.spec + screenshots |
| R4 | 52px one-row header: mark, screen title, count, search, avatar. Page titles/descriptions scroll away; header stays stable. | `MobileAppHeader` (52px, sticky, backdrop blur). `PageHeader` collapses/hides below `md`. | mobile.spec |
| R5 | Metric rows scroll horizontally (112px cards, one peeking at the edge) instead of wrapping. | `MobileMetricStrip` (hidden scrollbar, peek fade). | mobile.spec |
| R6 | Hit targets ≥44px; primary actions in the thumb zone. | 44px+ targets throughout; `MobileActionBar` pins container actions above the safe area. | mobile.spec |

## Defect panel (from `Noderaft Mobile.dc.html` — acceptance list)

| # | Defect in production | Prescribed fix | Status |
|---|----------------------|----------------|--------|
| D1 | Tables reflowed into unreadable columns | Cards below 768px: mono name line with `word-break: break-all`, badges row, single mono metric strip. No label prefixes. | FIXED + VERIFIED |
| D2 | Sidebar became a full-page list | Five destinations → bottom tab bar with Attention badge; Clients/Users/Notifications/API keys → account sheet. | FIXED + VERIFIED |
| D3 | Five stacked selects ate the viewport | One Filters button + active count → sheet with 38px chips; primary button states the result (“Show 38 containers”). | FIXED + VERIFIED |
| D4 | Header covered content and clipped text | One 52px row (mark, title, count, search, avatar); titles scroll away. | FIXED + VERIFIED |
| D5 | Metric rows wrapped raggedly | Horizontal scroll strip, 112px cards, one peeking at the edge. | FIXED + VERIFIED |
| D6 | Primary actions sat above the fold | Restart/Stop/Logs pinned to the bottom bar (50px) in the thumb zone above the safe area. | FIXED + VERIFIED |

## Screen-by-screen coverage

### 01 · Overview (design §01)
| Design element | Production screen | Current state (before) | Implementation action | Verification |
|---|---|---|---|---|
| 52px header with mark/title/search/avatar | admin Overview `/admin` | desktop sticky header + big PageHeader | MobileAppHeader; PageHeader hidden on mobile | mobile.spec |
| Fleet health banner “Nothing needs you” (green, check icon, mono summary) | admin Overview fleet section | large 5-card grid + header description | MobileOverview health banner from fleetSummary | screenshot |
| Horizontal metric strip (Nodes/Workloads/Containers 112px cards + peek) | admin Overview fleet summary | `md:grid-cols-5` grid (wraps) | MobileMetricStrip (5 metrics, horizontal scroll) | screenshot |
| Needs Attention treatment (cards) | admin Overview attention | desktop cards | compact mobile cards, same data | mobile.spec |
| Compact workload summaries (name, health chip, mono context, 4px health bar) | admin Overview workloads | desktop grid cards | MobileWorkloadCard (dense) | screenshot |
| Node/resource summaries | admin Overview nodes | desktop cards | compact node rows | screenshot |
| Bottom navigation | all | — | MobileBottomNav | mobile.spec |

### 02 · Containers (design §02)
| Design element | Production screen | Current state | Implementation action | Verification |
|---|---|---|---|---|
| Cards instead of table | admin Containers `/admin/containers` | ServerDataTable + `min-w` selects | mobileCard (name mono break-all, dot, badges, mono metric strip) | screenshot |
| Header: back chevron, title, count, search, avatar | admin Containers | desktop header | sheet-entry root with back target | mobile.spec |
| Filter row: `[Filters 2] [Main VPS] [Running]` | admin Containers | 5 stacked selects + search | mobileToolbar: Filters button + active chips | screenshot |
| Stopped card (opacity, “stopped by you · 3d ago”) | admin Containers | table row | stopped-card treatment with intentional-stop context | mobile.spec |

### 03 · Filter sheet (design §03)
| Design element | Production screen | Current state | Implementation action | Verification |
|---|---|---|---|---|
| Bottom sheet, 22px top radius, drag handle | Containers/Workloads/Attention/Activity | desktop selects/modals | `FilterSheet` shared primitive | screenshot |
| Chip groups (38px, selected cyan) | same | selects | chip groups: State/Node/Client/Workload/Health | mobile.spec |
| Toggles (44px rows, 40×24 switch) | same | checkboxes | needs-attention + hide-client-owned toggles | mobile.spec |
| Reset link | same | — | Reset clears all | mobile.spec |
| Cancel + `Show N containers` (48px primary) | same | — | live result count when computable; `Apply filters` otherwise | mobile.spec |

### 04 · Container detail (design §04)
| Design element | Production screen | Current state | Implementation action | Verification |
|---|---|---|---|---|
| Header: back, mono truncated name, ellipsis | admin container detail | desktop header + PageHeader | MobileAppHeader shows container name; ellipsis → overflow menu | screenshot |
| Status block (badge, “3 restarts in 10 min”, explanation) | admin container detail | attention banners | mobile status block | screenshot |
| Metric strip CPU/Memory/Uptime (106px cards) | admin container detail | desktop stats grid | MobileMetricStrip | screenshot |
| Tabs Logs/Config/Events | admin container detail | single scroll page | mobile tab bar (Logs default; Config = details/networks/volumes/labels; Events = activity) | mobile.spec |
| Logs full width, internal h-scroll, streaming indicator | admin container detail | desktop right column | LogViewer full-width on mobile; `overflow-x-auto` lines | mobile.spec |
| Pinned actions Restart/Stop/Logs (50px, thumb zone) | admin container detail | inline buttons above fold | MobileActionBar pinned above bottom nav, state-aware, safe-area | mobile.spec |

### 05 · Activity (design §05)
| Design element | Production screen | Current state | Implementation action | Verification |
|---|---|---|---|---|
| Grouped by day (Today/Yesterday headers) | admin Activity | flat ActivityTimeline | MobileActivityList day grouping | screenshot |
| One line per event: icon, humanized action, mono resource, actor · time, right timeAgo | admin Activity | multi-line cards | dense rows | mobile.spec |
| Collapsed “×3 more … Expand” | admin Activity | — | consecutive-similar collapse + expand | mobile.spec |
| Filter pill in header | admin Activity | desktop selects | header Filter pill → shared FilterSheet (event bus) | mobile.spec |

### 06 · Nodes (design §06)
| Design element | Production screen | Current state | Implementation action | Verification |
|---|---|---|---|---|
| Node card: icon, name, hostname, online badge | admin Nodes | DataTable | NodeCard | screenshot |
| CPU/RAM resource bars (5px, cyan/amber) | admin Nodes | ResourceUsageStrip in table | compact bars | screenshot |
| Footer: containers · agent/rootless · ♥ heartbeat | admin Nodes | table columns | mono footer row | mobile.spec |
| Dashed “Add node” card | admin Nodes | header button | dashed card opens enrollment modal | mobile.spec |

### 07 · Account sheet (design §07)
| Design element | Production screen | Current state | Implementation action | Verification |
|---|---|---|---|---|
| Drag handle, identity row (44px avatar, name, email · role) | all mobile screens | desktop account menu | AccountSheet | screenshot |
| Clients / Users & roles / Notifications rows with counts | all mobile screens | sidebar items | sheet rows, close-on-select | mobile.spec |
| Containers row (prompt requirement) | all mobile screens | sidebar | sheet row under Resources | mobile.spec |
| Account settings + Log out (danger) | all mobile screens | desktop menu | sheet rows | mobile.spec |
| Version footer | all mobile screens | — | mono version line | mobile.spec |

## Additional screens (derived from component rules — no full mock)

### Workloads root (tab) — §16
WorkloadCard: name, node, running/total, health chip, CPU/mem, intentional-stop count. FilterSheet for node/client/state/source/attention.

### Attention — §15
Compact state tabs (Active/Acknowledged/Silenced/Resolved), Filters button, condition list high in viewport (severity badge, title, detail, timestamps, ack/silence context). Modals for ack/silence/maintenance unchanged (accessible).

### Node detail — metric strip (CPU/RAM/Disk/Containers), compact Host/Containers stats, Workloads/Containers tabs with mobileCards, Activity tab with MobileActivityList.

### Workload detail — compact overview stats, Containers tab mobileCards, Activity tab MobileActivityList, deployment/editor flows unchanged (forms remain usable).

### Clients — ClientCard (name, users/workloads/containers, state, last activity). Create modal unchanged.

### Users & roles — UserCard (name/email, role/status badges, last login, overflow actions). Invite modal unchanged.

### Notifications — destinations cards + delivery history as compact cards (replaces the `min-w-[760px]` table).

### Client surfaces — `/client` overview mobile layout; client workloads/containers mobileCards; client activity MobileActivityList; team UserCards.

## Component architecture (canonical, shared)
- `MobileAppHeader` — 52px header
- `MobileBottomNav` — 5-tab bottom bar
- `AccountSheet` — admin/secondary destinations
- `FilterSheet` — one shared filter sheet
- `MobileResourceCard` — canonical card family (title/subtitle/status/metrics/attention/overflow)
- `MobileMetricStrip` + `MobileMetricCard` — horizontal metric rows
- `MobileActionBar` — pinned container actions
- `MobileActivityList` — grouped dense activity
- `MobileSheet` — safe-area bottom-sheet primitive
- Reused canonicals: `StatusBadge`, `ResourceUsage`, `Badge`, `Menu`, `Modal`, `ConfirmDialog`, `LogViewer`, `TabBar`, breadcrumbs/navigation context.

## Horizontal overflow gate (every mobile route)
`document.documentElement.scrollWidth <= document.documentElement.clientWidth` at 390px — asserted in `tests/mobile.spec.ts` for every route. Internal scroll regions only: logs, metric strips, tab strips.

## Verification summary
- Seven reference screens at 390×844: Overview / Containers / Filter sheet / Container detail / Activity / Nodes / Account sheet — screenshots in `artifacts/noderaft-mobile-design/qa/`.
- Additional screens: Workloads / Attention / Clients / Users / Notifications / Node detail / Workload detail.
- Desktop (≥1280px) unchanged: sidebar, tables, toolbars, detail layouts.
