"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Boxes, Box, Loader2, Search, Server, Users, CornerDownLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/fetcher";
import type { SearchGroup, SearchResultItem } from "@/server/services/search";

/**
 * Global search / command palette.
 *
 * - Opens with Ctrl+K / Cmd+K from anywhere in the dashboard.
 * - Debounced server-side search; results grouped by entity type.
 * - Fully keyboard navigable: ↑/↓ to move, Enter to open, Esc to close.
 * - The search scope (admin vs client) is derived from the current route, and
 *   the server enforces authorization independently of this UI.
 */

type SearchPayload = { groups: SearchGroup[] };

const GROUP_ICON: Record<SearchResultItem["type"], typeof Box> = {
  workload: Boxes,
  container: Box,
  node: Server,
  client: Users
};

export function CommandPalette(): React.JSX.Element | null {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isAdmin = pathname.startsWith("/admin");

  const flat = useMemo<SearchResultItem[]>(() => groups.flatMap((g) => g.items), [groups]);

  // Global hotkey + programmatic open (from the header search button).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = (): void => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("hostpanel:open-search", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hostpanel:open-search", onOpen);
    };
  }, []);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setGroups([]);
      setLoading(false);
      setError(null);
      setCursor(0);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    const timer = setTimeout(async () => {
      try {
        const endpoint = isAdmin ? "/api/admin/search" : "/api/client/search";
        const payload = await apiFetch<SearchPayload>(
          `${endpoint}?q=${encodeURIComponent(q)}`,
          { signal: controller.signal }
        );
        if (!controller.signal.aborted) {
          setGroups(payload.groups);
          setCursor(0);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setGroups([]);
          setError(err instanceof Error ? err.message : "Search failed");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open, isAdmin]);

  // Reset when opening.
  useEffect(() => {
    if (open) {
      setQuery("");
      setGroups([]);
      setError(null);
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const navigate = useCallback(
    (href: string): void => {
      setOpen(false);
      router.push(href);
    },
    [router]
  );

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(flat.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = flat[cursor];
      if (item) navigate(item.href);
    }
  };

  // Keep the highlighted item in view.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor, flat]);

  if (!open) return null;

  let flatIndex = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search size={16} className="text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={isAdmin ? "Search workloads, containers, nodes, clients…" : "Search workloads and containers…"}
            aria-label="Search"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">ESC</kbd>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> Searching…
            </div>
          ) : error ? (
            <p className="p-4 text-sm text-red-400">{error}</p>
          ) : !query.trim() ? (
            <p className="p-4 text-sm text-muted">Type to search across HostPanel.</p>
          ) : flat.length === 0 ? (
            <p className="p-4 text-sm text-muted">No results for “{query}”.</p>
          ) : (
            groups.map((group) => (
              <div key={group.type} className="mb-1">
                <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {group.label}
                </p>
                {group.items.map((item) => {
                  const index = flatIndex++;
                  const Icon = GROUP_ICON[item.type];
                  return (
                    <button
                      key={`${item.type}-${item.id}`}
                      type="button"
                      data-index={index}
                      onClick={() => navigate(item.href)}
                      onMouseEnter={() => setCursor(index)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition",
                        cursor === index ? "bg-panelAlt text-text" : "text-muted"
                      )}
                    >
                      <Icon size={15} className="shrink-0 text-accent" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-text">{item.title}</span>
                        {item.subtitle && (
                          <span className="block truncate text-xs text-muted">{item.subtitle}</span>
                        )}
                      </span>
                      {item.meta && <span className="shrink-0 text-xs text-muted">{item.meta}</span>}
                      {cursor === index && <CornerDownLeft size={12} className="shrink-0 text-muted" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
