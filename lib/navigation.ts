/**
 * Persistent navigation-context model (client-only).
 *
 * The breadcrumb is the user's investigation trail — where they navigated — not
 * a static site hierarchy. The trail and its "root" (sidebar origin) are stored
 * per-URL in sessionStorage so that:
 *  - browser Back/Forward restores the exact trail (each history entry's URL
 *    maps back to the context that was current when it was pushed), and
 *  - a refresh in the same tab/session restores the same trail.
 * A fresh tab / deep link with no stored context falls back to a route-derived
 * breadcrumb and root.
 */

export type NavEntryKind = "root" | "resource" | "tab";

export type NavEntry = {
  kind: NavEntryKind;
  label: string;
  url: string;
  /** Resource type ("node" | "workload" | "container" | "client" | …) for dedup/cycle handling. */
  type?: string;
  /** Stable resource identity (e.g. cuid) for dedup/cycle handling. */
  id?: string;
};

export type NavRootKey =
  | "overview"
  | "workloads"
  | "nodes"
  | "organizations"
  | "attention"
  | "activity"
  | "users"
  | "containers"
  | "alerting"
  | "platformSettings"
  | "members"
  | "settings"
  | "domains"
  | "ingress"
  // Legacy keys remain readable for old sessionStorage entries.
  | "clients"
  | "notifications"
  | "team";

export type NavContextState = {
  rootKey: NavRootKey;
  rootHref: string;
  stack: NavEntry[];
};

export type RootDef = { key: NavRootKey; href: string; label: string };

const MAP_KEY = "noderaft:nav:byUrl";
const MAX_ENTRIES = 60;

export function currentUrl(pathname: string, search: string): string {
  return search ? `${pathname}?${search}` : pathname;
}

function readMap(): Record<string, NavContextState> {
  try {
    const raw = window.sessionStorage.getItem(MAP_KEY);
    return raw ? (JSON.parse(raw) as Record<string, NavContextState>) : {};
  } catch {
    return {};
  }
}

export function loadContext(url: string): NavContextState | null {
  try {
    const context = readMap()[url];
    if (!context) return null;
    return normalizeContext(context);
  } catch {
    return null;
  }
}

/** Migrate persisted navigation labels/roots without invalidating the trail. */
function normalizeContext(context: NavContextState): NavContextState {
  const label = (value: string): string => ({
    Client: "Organization",
    Clients: "Organizations",
    Team: "Members",
    Users: "All Users",
    Notifications: "Alerting"
  }[value] ?? value);
  const url = (value: string): string => value
    .replace(/^\/admin\/clients(?=\/|$)/, "/organizations")
    .replace(/^\/client(?=\/|$)/, "/organization");
  const rootKey = context.rootKey === "clients" ? "organizations" : context.rootKey === "team" ? "members" : context.rootKey === "notifications" ? "alerting" : context.rootKey;
  return {
    rootKey,
    rootHref: url(context.rootHref),
    stack: context.stack.map((entry) => ({ ...entry, label: label(entry.label), url: url(entry.url), type: entry.type === "client" ? "organization" : entry.type }))
  };
}

export function saveContext(url: string, ctx: NavContextState): void {
  try {
    const map = readMap();
    map[url] = ctx;
    // Prune the oldest entries to keep sessionStorage bounded.
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
    }
    window.sessionStorage.setItem(MAP_KEY, JSON.stringify(map));
  } catch {
    /* storage disabled/unavailable — navigation still works */
  }
}

export const ADMIN_ROOTS: Record<string, RootDef> = {
  overview: { key: "overview", href: "/admin", label: "Overview" },
  workloads: { key: "workloads", href: "/admin/workloads", label: "Workloads" },
  containers: { key: "containers", href: "/admin/containers", label: "Containers" },
  attention: { key: "attention", href: "/admin/attention", label: "Attention" },
  activity: { key: "activity", href: "/admin/activity", label: "Activity" },
  nodes: { key: "nodes", href: "/admin/nodes", label: "Nodes" },
  organizations: { key: "organizations", href: "/organizations", label: "Organizations" },
  users: { key: "users", href: "/admin/settings/users", label: "All Users" },
  alerting: { key: "alerting", href: "/admin/settings/notifications", label: "Alerting" },
  ingress: { key: "ingress", href: "/admin/infrastructure/ingress", label: "Ingress" },
  platformSettings: { key: "platformSettings", href: "/admin/settings", label: "Platform Settings" }
};

export const CLIENT_ROOTS: Record<string, RootDef> = {
  overview: { key: "overview", href: "/organization", label: "Overview" },
  workloads: { key: "workloads", href: "/organization/workloads", label: "Workloads" },
  containers: { key: "containers", href: "/organization/containers", label: "Containers" },
  domains: { key: "domains", href: "/organization/domains", label: "Domains" },
  attention: { key: "attention", href: "/organization/attention", label: "Attention" },
  activity: { key: "activity", href: "/organization/activity", label: "Activity" },
  members: { key: "members", href: "/organization/members", label: "Members" },
  settings: { key: "settings", href: "/organization/settings", label: "Settings" }
};

export const PLATFORM_NAV_KEYS = [
  "overview",
  "workloads",
  "containers",
  "attention",
  "activity",
  "nodes",
  "organizations",
  "users",
  "alerting",
  "platformSettings"
] as const;

export const ORGANIZATION_OPERATIONAL_KEYS = ["overview", "workloads", "containers", "attention", "activity"] as const;

export function navigationKeysForRole(role: string): readonly string[] {
  return role === "ADMIN"
    ? PLATFORM_NAV_KEYS
    : role === "CLIENT" || role === "CLIENT_ADMIN"
      ? [...ORGANIZATION_OPERATIONAL_KEYS, "members", "settings"]
      : ORGANIZATION_OPERATIONAL_KEYS;
}

/**
 * Mobile account-sheet destinations (design §07). These are NOT bottom-tab
 * roots: they keep the current navigation-root semantics (Containers lives
 * under the Workloads surface per the design mock) and the sheet records a
 * return root so the mobile header back chevron returns to the previous tab.
 */
export const CONTAINER_SHEET_ROOT: RootDef = {
  key: "workloads",
  href: "/admin/containers",
  label: "Containers"
};

export const MOBILE_SHEET_DESTINATIONS: Record<string, RootDef> = {
  containers: CONTAINER_SHEET_ROOT,
  organizations: { key: "organizations", href: "/organizations", label: "Organizations" },
  users: { key: "users", href: "/admin/settings/users", label: "All Users" },
  alerting: { key: "alerting", href: "/admin/settings/notifications", label: "Alerting" },
  platformSettings: { key: "platformSettings", href: "/admin/settings", label: "Platform Settings" },
  members: CLIENT_ROOTS.members,
  settings: CLIENT_ROOTS.settings
};

function rootEntry(def: RootDef): NavEntry {
  return { kind: "root", label: def.label, url: def.href };
}

function resourceEntry(label: string, url: string, type: string): NavEntry {
  return { kind: "resource", label, url, type };
}

/**
 * Route-derived fallback for a direct URL with no stored navigation context.
 * Labels are generic where the resource name isn't derivable from the path;
 * detail pages fill in the real name via `renameCurrent`.
 */
export function deriveFallback(pathname: string, search: string): NavContextState | null {
  const url = currentUrl(pathname, search);
  const tab = /[?&]tab=([^&]+)/.exec(search)?.[1] ?? null;
  const tabLabel = tab ? tab.replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase()) : null;

  const admin = [
    { re: /^\/admin$/, root: "overview" },
    { re: /^\/admin\/workloads\/[^/]+$/, root: "workloads", type: "workload", label: "Workload" },
    { re: /^\/admin\/workloads$/, root: "workloads" },
    { re: /^\/admin\/nodes\/[^/]+$/, root: "nodes", type: "node", label: "Node" },
    { re: /^\/admin\/nodes$/, root: "nodes" },
    { re: /^(?:\/admin\/clients|\/organizations)\/[^/]+$/, root: "organizations", type: "organization", label: "Organization" },
    { re: /^(?:\/admin\/clients|\/organizations)$/, root: "organizations" },
    { re: /^\/admin\/attention$/, root: "attention" },
    { re: /^\/admin\/activity$/, root: "activity" },
    { re: /^\/admin\/settings\/users$/, root: "users" },
    { re: /^\/admin\/settings\/containers$/, root: "containers" },
    { re: /^\/admin\/settings\/notifications$/, root: "alerting" },
    { re: /^\/admin\/infrastructure\/ingress$/, root: "ingress" },
    { re: /^\/admin\/settings$/, root: "platformSettings" }
  ] as const;

  // Containers is a mobile sheet destination rooted under the Workloads
  // surface (design §02 mock highlights the Workloads tab).
  if (/^\/admin\/containers$/.test(pathname)) {
    return {
      rootKey: CONTAINER_SHEET_ROOT.key,
      rootHref: CONTAINER_SHEET_ROOT.href,
      stack: [rootEntry(CONTAINER_SHEET_ROOT)]
    };
  }
  if (/^\/admin\/containers\/[^/]+\/[^/]+$/.test(pathname)) {
    const stack: NavEntry[] = [rootEntry(CONTAINER_SHEET_ROOT), resourceEntry("Container", pathname, "container")];
    if (tabLabel) stack.push({ kind: "tab", label: tabLabel, url });
    return { rootKey: CONTAINER_SHEET_ROOT.key, rootHref: CONTAINER_SHEET_ROOT.href, stack };
  }

  for (const rule of admin) {
    if (rule.re.test(pathname)) {
      const def = ADMIN_ROOTS[rule.root];
      const stack: NavEntry[] = [rootEntry(def)];
      if ("type" in rule && rule.type) {
        stack.push(resourceEntry(rule.label ?? "Resource", pathname, rule.type));
        if (tabLabel) stack.push({ kind: "tab", label: tabLabel, url });
      }
      return { rootKey: def.key, rootHref: def.href, stack };
    }
  }

  const client = [
    { re: /^(?:\/client|\/organization)$/, root: "overview" },
    { re: /^(?:\/client|\/organization)\/workloads\/[^/]+$/, root: "workloads", type: "workload", label: "Workload" },
    { re: /^(?:\/client|\/organization)\/workloads$/, root: "workloads" },
    { re: /^(?:\/client|\/organization)\/containers\/[^/]+$/, root: "containers", type: "container", label: "Container" },
    { re: /^(?:\/client|\/organization)\/containers$/, root: "containers" },
    { re: /^(?:\/client|\/organization)\/domains$/, root: "domains" },
    { re: /^(?:\/client|\/organization)\/attention$/, root: "attention" },
    { re: /^(?:\/client|\/organization)\/activity$/, root: "activity" },
    { re: /^(?:\/client|\/organization)\/(?:team|members)$/, root: "members" },
    { re: /^(?:\/client|\/organization)\/settings$/, root: "settings" }
  ] as const;

  for (const rule of client) {
    if (rule.re.test(pathname)) {
      const def = CLIENT_ROOTS[rule.root];
      const stack: NavEntry[] = [rootEntry(def)];
      if ("type" in rule && rule.type) stack.push(resourceEntry(rule.label ?? "Resource", pathname, rule.type));
      return { rootKey: def.key, rootHref: def.href, stack };
    }
  }

  return null;
}

/**
 * Compute the next stack when navigating to `entry` from the current stack.
 * Cycle handling: if the entry (by url) already exists in the stack, truncate
 * back to it rather than appending a duplicate. A tab entry that directly
 * follows a resource on the same page is replaced, not appended.
 */
export function extendStack(stack: NavEntry[], entry: NavEntry): NavEntry[] {
  const existingIndex = stack.findIndex((e) => e.url === entry.url);
  if (existingIndex >= 0) {
    return stack.slice(0, existingIndex + 1);
  }
  // Avoid duplicate consecutive entries (same url).
  const last = stack[stack.length - 1];
  if (last && last.url === entry.url) return stack;
  return [...stack, entry];
}
