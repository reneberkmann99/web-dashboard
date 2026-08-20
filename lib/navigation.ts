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
  | "clients"
  | "attention"
  | "activity"
  | "users"
  | "containers"
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
    return readMap()[url] ?? null;
  } catch {
    return null;
  }
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
  nodes: { key: "nodes", href: "/admin/nodes", label: "Nodes" },
  clients: { key: "clients", href: "/admin/clients", label: "Clients" },
  attention: { key: "attention", href: "/admin/attention", label: "Attention" },
  activity: { key: "activity", href: "/admin/activity", label: "Activity" },
  users: { key: "users", href: "/admin/settings/users", label: "Users" },
  containers: { key: "containers", href: "/admin/settings/containers", label: "Containers" },
  notifications: { key: "notifications", href: "/admin/settings/notifications", label: "Notifications" }
};

export const CLIENT_ROOTS: Record<string, RootDef> = {
  overview: { key: "overview", href: "/client", label: "Overview" },
  workloads: { key: "workloads", href: "/client/workloads", label: "Workloads" },
  activity: { key: "activity", href: "/client/activity", label: "Activity" },
  team: { key: "team", href: "/client/team", label: "Team" }
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
    { re: /^\/admin\/clients\/[^/]+$/, root: "clients", type: "client", label: "Client" },
    { re: /^\/admin\/clients$/, root: "clients" },
    { re: /^\/admin\/attention$/, root: "attention" },
    { re: /^\/admin\/activity$/, root: "activity" },
    { re: /^\/admin\/settings\/users$/, root: "users" },
    { re: /^\/admin\/settings\/containers$/, root: "containers" },
    { re: /^\/admin\/settings\/notifications$/, root: "notifications" },
    { re: /^\/admin\/containers\/[^/]+\/[^/]+$/, root: "containers", type: "container", label: "Container" }
  ] as const;

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
    { re: /^\/client$/, root: "overview" },
    { re: /^\/client\/workloads\/[^/]+$/, root: "workloads", type: "workload", label: "Workload" },
    { re: /^\/client\/workloads$/, root: "workloads" },
    { re: /^\/client\/containers\/[^/]+$/, root: "workloads", type: "container", label: "Container" },
    { re: /^\/client\/containers$/, root: "workloads" },
    { re: /^\/client\/activity$/, root: "activity" },
    { re: /^\/client\/team$/, root: "team" }
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
