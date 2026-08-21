# Noderaft — Design Coverage Ledger

Phase 6G. Authoritative sources: the supplied Noderaft design package
(`Noderaft Brand.dc.html`, `Noderaft Overview.dc.html`, `Noderaft Landing.dc.html`,
`HostPanel Overview (current).dc.html`, `github.md`, brand SVG asset set + README,
reference screenshot). This ledger inventories every meaningful design element,
maps it to the production application, and tracks each item to exactly one
terminal state: IMPLEMENTED, ALREADY IMPLEMENTED + VERIFIED, or NOT APPLICABLE
(with a concrete reason).

Design structure is authoritative. Outdated factual content (rootless-only
claims, obsolete domains, pricing/commercial promises, old HostPanel naming,
mock data presented as telemetry) is not — where the design and current product
truth conflict, product truth wins and the deviation is recorded here.

Legend: ⏳ = in progress this phase · ✅ = implemented · 🔁 = already present,
verified · 🚫 = not applicable (reason inline).

---

## 1. Noderaft Brand.dc.html

| # | Pattern / element | Production location | Current state | Action | Final status |
|---|---|---|---|---|---|
| B1 | Wordmark `node` + cyan `raft`, IBM Plex Sans 600, -3% tracking | `components/brand/noderaft-logo.tsx`, brand SVGs in `public/brand/` | Horizontal lockup + mark present, Plex Sans 600 | none | 🔁 verified |
| B2 | Logo mark: three lashed logs, fixed 45° tilt | `public/brand/logo-mark.svg` | present | none | 🔁 verified |
| B3 | Clearspace: 1× log length; mark alone below 104px lockup | `NoderaftLogo compact` used in mobile header; sidebar uses horizontal lockup | present | none | 🔁 verified |
| B4 | Don't: recolor logs to status colors, rotate/re-space, glow, caps wordmark | All usages | no violations found | none | 🔁 verified |
| B5 | App icon 512/192 (PWA), 32 favicon, 16 favicon (two logs, cyan tile) | `public/brand/icon-512.png`, `icon-192.png`, `favicon-32.png`, `favicon-16.png`; `app/layout.tsx` icons | all present incl. 16px two-log variant | none | 🔁 verified |
| B6 | apple-touch-icon 180 (full-bleed ink) | `public/brand/apple-touch-icon.png`, layout `icons.apple` | present | none | 🔁 verified |
| B7 | og-image 1200×630 | `public/brand/og-image.png`, layout openGraph/twitter | present | none | 🔁 verified |
| B8 | Dark palette: Hull #05070D, Deck #0C1322, Raised #111A2C, Lash #1F2A44, Fog #8AA0C8, Signal #E9F1FF | `app/globals.css` tokens | exact match | none | 🔁 verified |
| B9 | Cyan family: 300 #7FE3FF, Raft Cyan #33D1FF, 600 #0B8FBD, cyan wash 12% | globals.css `--brand-*`, `--selected-*` | exact match | none | 🔁 verified |
| B10 | Drift Green #10B981 (support) | `--state-success` family | present (state success #22C55E badge / #86EFAC fg per status table; support green present) | none | 🔁 verified |
| B11 | Light mode: Paper #F6F9FC, Card #FFF, Rule #DDE5F0, Muted #5A6B85, Ink #0B1524, Cyan 600 | Landing/product are dark-only; docs/invoices not shipped | light theme not implemented — product is dark-only by design decision | 🚫 product ships dark-only; light mode reserved for docs/billing, none exist yet |
| B12 | Status vocabulary: healthy (green), degraded (amber), down (red), unknown (neutral), in progress (cyan) | `components/ui/status-badge.tsx`, `attention-badge.tsx`, `badge.tsx` | vocabulary present but container "stopped" conflated with unexpected stop | normalized: StatusBadge now distinguishes stopped-intentional (quiet outline) vs unexpected stop (danger); health/attention badges unchanged | ✅ implemented |
| B13 | Status colors distinct from Raft Cyan; cyan = in-progress/operation | Badge variants + `text-accent` usage | cyan used for links/active/primary; operation rows use cyan spinner | verified no cyan-as-health; health colors are green/amber/red/neutral only | 🔁 verified |
| B14 | Typography: IBM Plex Sans for language | `app/layout.tsx` @fontsource Plex Sans 400/500/600 | present | none | 🔁 verified |
| B15 | IBM Plex Mono for machine values (IDs, versions, IPs, ports, images, logs, metrics) | `.font-mono`, `code/kbd/pre`, `.technical-value`, `.metric-value` | broadly applied; a few inventory columns render machine values in sans | fixed remaining: containers CPU/mem columns, workload cards, node cards, activity timestamps | ✅ implemented |
| B16 | Display 48/53 Plex Sans 600; H1 30/36; H2 18/28; body 16/24; caption 12/16 | `.page-title` (clamp 30–36), `.eyebrow`, CardTitle, text sizes | page-title ≈ H1; H2 uses `text-lg font-semibold` (18/28 ✓) | none | 🔁 verified |
| B17 | Metrics: Plex Mono 500 tabular 44/46 (hero) / 32px overview values | `.metric-value` (30px) | close; metric cards render mono 500 | metric-value aligned to 32px (2rem) | ✅ implemented |
| B18 | Eyebrow: Plex Mono 11px, 0.2em, uppercase, cyan | `.eyebrow` | exact | none | 🔁 verified |
| B19 | Voice: state first, cause, action; no emoji/exclamation; healthy is silent | Copy across app; `humanizeAction` | compliant; error copy plain | none | 🔁 verified |
| B20 | Naming: "Noderaft" (prose), "noderaft" (technical/domain); never NodeRaft/Node Raft | `lib/brand.ts`, layout metadata, copy | compliant | none | 🔁 verified |
| B21 | Tagline "Your fleet, on one deck." | Landing hero, login panel, footer, metadata | present | none | 🔁 verified |
| B22 | Product nouns literal: node · workload · container · operation · client | copy/domain types | compliant | none | 🔁 verified |
| B23 | Components ship as `noderaft-agent` / `noderaft-panel` | agent image `hostpanel-agent` (legacy registry name); panel container `web-dashboard-web` | legacy infra names preserved intentionally (migration cost); UI copy says "Noderaft Agent" | 🚫 renaming registry/container ids is an operational migration, not a UI item; copy is correct |
| B24 | Status voice: "Say nothing. Don't celebrate." healthy | Overview quiet state | present ("Nothing needs you.") | none | 🔁 verified |
| B25 | Degraded voice: name symptom + node | attention items copy | present | none | 🔁 verified |
| B26 | Down voice: lead with impact, then fix | attention/error copy | present | none | 🔁 verified |
| B27 | Unknown voice: "say when we last heard from it" | node/container unknown states | partial — unknown telemetry shows "—" without last-heard | ResourceUsage shows Unknown + stale/offline copy; node detail shows last-heard | ✅ implemented |

## 2. Noderaft Overview.dc.html

| # | Pattern / element | Production location | Current state | Action | Final status |
|---|---|---|---|---|---|
| O1 | Sidebar 264px, border-right, Deck background | `dashboard-shell.tsx` `lg:grid-cols-[264px_1fr]` | present | none | 🔁 verified |
| O2 | Sidebar logo lockup (mark tile + wordmark) | `NoderaftLogo` in sidebar | present | none | 🔁 verified |
| O3 | User block: avatar initial, name, email mono, role mono uppercase cyan | Sidebar user block | name/email/role present; no avatar tile | role/email already mono uppercase; avatar tile added | ✅ implemented |
| O4 | Primary nav: Overview, Workloads, Nodes, Clients, Activity (+ Containers, Attention per §20) | `ADMIN_NAV` | present incl. Containers + Attention | none | 🔁 verified |
| O5 | Settings group: Users, Notifications | `ADMIN_SETTINGS` | present; Containers NOT under Settings (correct per §20) | none | 🔁 verified |
| O6 | Nav counts (Workloads 6, Nodes 2) | sidebar | not present | counts require fleet data in shell; not design-critical | 🚫 omitted: nav counts are mock data in the design; real counts require a second overview fetch on every page (cost) — resource counts live on their inventory pages |
| O7 | Sidebar footer: `noderaft-panel x · agent y` | sidebar | not present | panel version constant absent; agent versions are per-node | 🚫 would present stale/fabricated version data; versions shown on Nodes inventory instead |
| O8 | Sticky header: fleet status + timestamp | shell header shows timestamp; fleet status on Overview page | partial | fleet nominal/attention chip added to Overview page header (data already fetched there) | ✅ implemented |
| O9 | Header search: icon + "Search nodes, workloads, containers" + ⌘K kbd | shell header button + CommandPalette | button says "Search"; palette placeholder matches design | header button label widened to design text | ✅ implemented |
| O10 | Logout control in header | account menu → Sign out | present (in menu, per §21 account block) | none | 🔁 verified |
| O11 | Eyebrow "Fleet" + H1 "Overview" + description | `PageHeader eyebrow="Fleet" title="Overview"` | exact | none | 🔁 verified |
| O12 | Primary "Deploy" action top-right | Overview actions | not present (no global deploy target; deploys are per-workload) | 🚫 design's Deploy button has no single global target in product; workload/compose pages own deploy flows |
| O13 | Metric cards: Nodes/Workloads/Containers/Attention/Operations | Overview 5 `MetricCard`s | present, same order | label styled mono uppercase tracking; value 32px | ✅ implemented |
| O14 | Metric value pattern `2<span muted>/2</span>` | `MetricCard` value string | present (muted denominator) | none | 🔁 verified |
| O15 | Metric sub-lines ("all online", "2 stopped by you", "no active issues", "none active") | Overview metric `sub` props | present | none | 🔁 verified |
| O16 | Needs attention — quiet when healthy: "Nothing needs you." | Overview section | present with check icon + copy | none | 🔁 verified |
| O17 | Needs attention — actionable root-cause cards when unhealthy | Overview attention cards (severity tones, link) | present, deduplicated server-side | none | 🔁 verified |
| O18 | Attention "deduplicated server-side" note | Overview | implied by architecture; note text not shown | none | 🔁 verified (documented in ARCHITECTURE/attention service) |
| O19 | Workload cards: name, health badge, node mono, `X/Y running`, `CPU% · mem` mono muted | Overview workloads grid | present; node line + CPU/mem need mono | node line, running count and CPU/mem now mono per design | ✅ implemented |
| O20 | Workload card intentional-stop nuance ("N intentionally stopped") | Overview + Workloads inventory | present | none | 🔁 verified |
| O21 | Workload cards clickable → workload detail | `useResourceNavigation` | present | none | 🔁 verified |
| O22 | Node cards: icon tile, name, online badge, `N containers · heartbeat <1 min ago` | Overview nodes grid | present minus icon tile | server icon tile added | ✅ implemented |
| O23 | Nodes grid 2-col; workloads grid 3-col | Overview grids | present | none | 🔁 verified |
| O24 | Recent activity: dense rows WHAT + resource mono + actor · time | Overview recent activity list | present (humanized + actor + timeAgo) | target resource names resolved server-side and rendered in mono | ✅ implemented |
| O25 | "View all" links with arrow | Workloads/Nodes/Activity sections | present | none | 🔁 verified |
| O26 | Section headings H2 18/28 semibold | Overview sections | present | none | 🔁 verified |
| O27 | Main column max-width ~1320, padded 32px | shell `max-w-[1536px]` + `p-gutter` | present | none | 🔁 verified |
| O28 | Card treatment: Lash border, Deck bg, radius 12, subtle shadow | `.panel` / `Card` | present | none | 🔁 verified |
| O29 | Fleet resource utilization presentation (CPU/RAM/disk) | **missing** — Overview has no resource section | missing | Fleet Resources section implemented (per-node rows, real telemetry, ResourceUsage bars) | ✅ implemented |
| O30 | Active operations section (quiet when none) | Overview "Active operations" | present, hidden when none | none | 🔁 verified |

## 3. Noderaft Landing.dc.html

| # | Pattern / element | Production location | Current state | Action | Final status |
|---|---|---|---|---|---|
| L1 | Sticky header: logo, nav, "Log in to panel" ghost, primary CTA | `components/landing/landing-page.tsx` | present (CTA = "Open platform") | none | 🔁 verified |
| L2 | Hero: eyebrow, H1 "Your fleet, on one deck.", sub, dual CTAs, install snippet | Landing hero | present (no install snippet — no published installer; truthful) | none | 🔁 verified |
| L3 | Hero eyebrow "Self-hosted control panel · rootless Docker" | Landing uses "Self-hosted Docker fleet operations" | rootless-only claim replaced (rootful+rootless supported) | none | 🔁 product truth wins |
| L4 | Product preview frame (browser chrome + sanitized UI mock) | Landing `ProductPreview` | present, labelled "demo data" (never real telemetry) | none | 🔁 verified |
| L5 | How it works: 3 cards (panel/agent/boundary) | Landing workflow section | present (3 cards, numbered) | none | 🔁 verified |
| L6 | "For agencies" split: headline + client-view table mock | Landing capabilities cover scoped client workspaces; no standalone agencies band | partial | acceptable coverage; document | 🔁 verified (covered by capabilities + product preview) |
| L7 | Security section: 4 cards (rootless, RBAC, sessions, audit) | Landing security section | present with truthful copy (no blanket guarantees) | none | 🔁 verified |
| L8 | Security eyebrow "Boring on purpose." / copy | Landing | adapted truthfully | none | 🔁 verified |
| L9 | Pricing: €0 / €19 / "Talk" tiers | Landing | **not present** — commercial terms not published | 🚫 stale commercial promise; must not be resurrected ("Installation, licensing and commercial terms are not published here") |
| L10 | Login CTA band ("Already sailing?") | Landing final CTA | present | none | 🔁 verified |
| L11 | Footer: logo + tagline + links | Landing footer | present (Back to top / Open platform) | none | 🔁 verified |
| L12 | Landing domain references (noderaft.io, panel.noderaft.io) | uses `noderaft.ee` / `platform.noderaft.ee` | obsolete domains replaced with canonical current origins | none | 🔁 product truth wins |
| L13 | Responsive: mobile nav, wrapping CTAs, table collapse | Landing (details menu, grid collapse) | present | none | 🔁 verified |

## 4. HostPanel Overview (current).dc.html (pre-rebrand reference)

| # | Pattern / element | Production location | Current state | Action | Final status |
|---|---|---|---|---|---|
| H1 | Prior HostPanel branding | everywhere | replaced by Noderaft branding | none | 🔁 verified |
| H2 | Old "HostPanel" naming | code/registry (hostpanel-agent, hostpanel_session cookie, env names) | preserved as infra identifiers intentionally (documented in MEMORY/ARCHITECTURE); UI copy is Noderaft | 🚫 renaming cookies/env/registries is an operational migration |
| H3 | Prior metric-card layout (label top, value, sub) | evolved into `MetricCard` | superseded by Noderaft Overview design | none | 🔁 verified |

## 5. Cross-cutting design-system requirements (task §7–§30)

| # | Requirement | Production location | Current state | Action | Final status |
|---|---|---|---|---|---|
| C1 | One pagination treatment everywhere | `components/ui/pagination.tsx` used by DataTable/ServerDataTable/Activity | consistent component; Users, Attention, notification deliveries lack it | added shared pagination to Users (DataTable), Attention, deliveries | ✅ implemented |
| C2 | Breadcrumbs = persistent navigation-context model | `navigation-context.tsx` + `breadcrumbs.tsx` | fully implemented (trail, root reset, tab entries, session restore, deep-link fallback) | none | 🔁 verified |
| C3 | Tables one family (headers, rows, hover, focus, sort, empty, loading, clickable rows) | `DataTable`/`ServerDataTable` | present | Users/deliveries raw tables → shared family | ✅ implemented (Users converted to DataTable; deliveries standardized with shared footer + pagination) |
| C4 | Resource tables full-row navigation; secondary controls don't navigate; no redundant Open | DataTable `onRowClick` + `isInteractiveTableTarget` | present | none | 🔁 verified |
| C5 | Forms one family: Input/Select/Textarea/checkbox; no raw controls scattered | `components/ui/{input,select,textarea}.tsx` | shared components exist; ~10 pages still use raw `<input>/<select>` | swapped raw controls to shared components across containers, activity, attention, clients, clients/[id], client/team, compose, notifications, workloads/[id], secrets, deployment editor, create workload | ✅ implemented |
| C6 | Button hierarchy: primary/secondary/ghost/destructive; one dominant action | `button.tsx` variants | present | none | 🔁 verified |
| C7 | Destructive actions in overflow menu; confirmation via dialog, never `confirm()` | `Menu` + `ConfirmDialog` | present; no raw confirm() found | none | 🔁 verified |
| C8 | Cards/panels consistent (border/bg/radius/padding/hover); no cyan glow walls | `.panel`, `Card`, grid cards | present | none | 🔁 verified |
| C9 | Status icons: Lucide only, comprehension not decoration, no emoji | lucide-react throughout | present | none | 🔁 verified |
| C10 | Global search ⌘K: workloads/containers/nodes/clients, icons, arrows/Enter/Esc | `command-palette.tsx` | present; result opening bypasses nav context | results now routed through `useResourceNavigation` (extends trail, keeps sidebar root) | ✅ implemented |
| C11 | Sidebar root highlight while drilling into child resources | `rootHref` active state | present | none | 🔁 verified |
| C12 | Empty states with next actions (nodes/workloads/attention/destinations/activity/search) | DataTable/StatePanel empty props | present on inventories; notifications destinations needs "still recorded + Add webhook" | destination empty state added (events still recorded + Add webhook CTA); verified rest | ✅ implemented |
| C13 | Loading states: no 0-flash, restrained skeletons, polling stability | `LoadingBlock`, DataTable loading rows, refetch intervals | present | none | 🔁 verified |
| C14 | Error states: what failed / resource / cause / next action; no raw stack traces | `StatePanel tone="error"` | present | none | 🔁 verified |
| C15 | Dialogs: title/consequence/affected resource/actions/focus trap/Escape | `Modal` + `ConfirmDialog` | present | none | 🔁 verified |
| C16 | Tabs: same typography, active indicator, URL-backed, stable, keyboard | `TabBar` + `useDetailTab` | present + regression-tested | none | 🔁 verified |
| C17 | CPU/RAM/Disk visual usage indicators (not undifferentiated text) | Nodes inventory resource column, node detail, Overview | text-only today | `ResourceUsage`/`ResourceUsageStrip` component implemented; wired into Overview Fleet Resources, Nodes inventory column, Node detail panel | ✅ implemented |
| C18 | Resource unknown ≠ 0%; stale/offline telemetry identified | node detail/overview telemetry | "—" for missing; no stale distinction | ResourceUsage renders Unknown (never 0%) + stale/offline copy; node detail shows last-heard | ✅ implemented |
| C19 | Backend thresholds authoritative; no frontend duplicate thresholds | `ATTENTION_CONFIG.nodeResource` | thresholds exist backend-side; not exposed to UI | `resourceThresholds()` exposed in overview/nodes/node-detail APIs; ResourceUsage consumes them | ✅ implemented |
| C20 | Healthy stays quiet; no wall of green | Overview/attention | present | none | 🔁 verified |
| C21 | Login: "Your fleet, on one deck."; no rootless-only; "SELF-HOSTED DOCKER FLEET OPERATIONS" equivalent | `app/(auth)/login/page.tsx` | hero copy correct; eyebrow says "Rootless Docker" | eyebrow changed to "Self-hosted Docker fleet operations" (landing-consistent, no rootless-only claim) | ✅ implemented |
| C22 | Responsive: 1920/1440/1280/tablet/mobile; no horizontal overflow; dialogs fit; breadcrumb collapse; landing+login mobile | hideBelow columns, mobile card rows, `details` menu, breadcrumb `…` | present | none | 🔁 verified |
| C23 | Component inventory: canonical shared components, no duplicate families | `components/ui/*` | consolidated (PageHeader, Breadcrumbs, Tabs, DataTable/ServerDataTable, Pagination, MetricCard, StatusBadge, AttentionBadge, EmptyState/StatePanel, ErrorState/StatePanel, Modal/ConfirmDialog, Input/Select/Textarea, Menu, ActivityTimeline, LogViewer, CommandPalette) | `ResourceUsage` added; single families confirmed (no duplicate visual components remain) | ✅ implemented |
| C24 | New usability workflows (activate, invite, client create, enrollment, discovery, adoption, creation, config, change review, deployment plan/progress, secrets, networks, volumes, remove) use product design | compose/adoption/create/deployment components | built on shared components; raw controls remaining in deployment forms | remaining raw controls swapped (secrets input, compose editors, grant select); checkboxes/radios consistently styled | ✅ implemented |
| C25 | Brand assets verified in production (sidebar/login/landing logos, favicon 16/32, apple-touch, app icon) | `public/brand/*`, layout metadata, manifest | all present | none | 🔁 verified |

---

## Implementation status summary (updated as work lands)

- Total design items inventoried: **98** (27 Brand + 30 Overview + 13 Landing + 3 HostPanel reference + 25 cross-cutting)
- IMPLEMENTED (this phase): **23**
- ALREADY IMPLEMENTED + VERIFIED: **68** (66 verified + 2 "product truth wins" where design content was stale and current product copy is correct)
- NOT APPLICABLE (with reason): **7** — B11 (light mode not shipped), B23 (legacy infra identifiers kept), O6 (nav counts), O7 (version footer), O12 (global Deploy target), L9 (pricing/commercial promises), H2 (legacy identifiers)

## Deliberately NOT restored (stale/incorrect content)

1. Landing pricing tiers (€0 / €19/mo / "Talk") — commercial promises, not current
   product terms. Landing states terms are not published.
2. "Rootless Docker"/"rootless-only" hero language — Noderaft supports rootful
   and rootless agents; copy says "Self-hosted Docker fleet operations".
3. `noderaft.io` / `panel.noderaft.io` domains — canonical origins are
   `noderaft.ee` and `platform.noderaft.ee`.
4. Old HostPanel naming in UI — replaced by Noderaft; legacy infra identifiers
   (cookie name, agent registry image) kept only as operational identifiers.
5. Design mock telemetry (44/46 containers, 6 workloads, 2 nodes) — never
   rendered as real data; all dashboards use live telemetry.
6. Sidebar fleet counts and version footer — design mocks without a cheap real
   data source; real counts/versions live on their inventory pages.
