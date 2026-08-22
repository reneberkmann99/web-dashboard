"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { MobileSheet } from "@/components/mobile/mobile-sheet";

/**
 * Shared mobile filter sheet (design §03). Replaces stacked desktop selects
 * below the mobile breakpoint:
 *  - 38px chips per group (selected = solid cyan)
 *  - 44px toggle rows
 *  - Reset link in the header
 *  - Cancel + primary action stating the result ("Show 38 containers")
 *
 * The sheet edits a DRAFT; nothing is applied until the primary action is
 * pressed, so closing the sheet preserves the applied filter state.
 * `onDraftChange` lets client-side-filtered pages show a live provisional
 * result count while the sheet is open.
 */

export type FilterChipOption = { value: string; label: string };
export type FilterChipGroup = {
  id: string;
  label: string;
  options: FilterChipOption[];
  multiple?: boolean;
  selected: string[];
};
export type FilterToggleRow = { id: string; label: string; checked: boolean };

export type FilterDraft = { groups: FilterChipGroup[]; toggles: FilterToggleRow[] };

function chipGroupsEqual(a: FilterChipGroup[], b: FilterChipGroup[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i].selected.join("\u0000");
    const y = b[i].selected.join("\u0000");
    if (x !== y) return false;
  }
  return true;
}

function togglesEqual(a: FilterToggleRow[], b: FilterToggleRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].checked !== b[i].checked) return false;
  }
  return true;
}

export function FilterSheet({
  open,
  onClose,
  title = "Filters",
  groups,
  toggles = [],
  onApply,
  onReset,
  resultCount,
  resultNoun,
  onDraftChange
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  groups: FilterChipGroup[];
  toggles?: FilterToggleRow[];
  /** Commit the current draft. */
  onApply: (draft: FilterDraft) => void;
  /** Clear every filter. */
  onReset: () => void;
  /** Live result count for the CURRENT applied filters (null → "Apply filters" when a draft is pending). */
  resultCount: number | null;
  /** Noun used in the primary label, e.g. "containers". */
  resultNoun: string;
  /** Called whenever the draft changes (client-side counts). */
  onDraftChange?: (draft: FilterDraft, applied: FilterDraft) => void;
}): React.JSX.Element {
  const applied = { groups, toggles };
  const [draft, setDraft] = useState<FilterDraft>(() => ({
    groups: groups.map((g) => ({ ...g, options: g.options.map((o) => ({ ...o })), selected: [...g.selected] })),
    toggles: toggles.map((t) => ({ ...t }))
  }));

  // Re-sync the draft whenever the sheet OPENS (applied state may change
  // while the sheet is closed; a draft in progress must never be reset).
  const appliedRef = useRef({ groups, toggles });
  appliedRef.current = { groups, toggles };
  useEffect(() => {
    if (!open) return;
    const current = appliedRef.current;
    setDraft({
      groups: current.groups.map((g) => ({ ...g, options: g.options.map((o) => ({ ...o })), selected: [...g.selected] })),
      toggles: current.toggles.map((t) => ({ ...t }))
    });
  }, [open]);

  const update = (next: FilterDraft): void => {
    setDraft(next);
    onDraftChange?.(next, applied);
  };

  const toggleChip = (groupId: string, value: string): void => {
    update({
      ...draft,
      groups: draft.groups.map((g) => {
        if (g.id !== groupId) return g;
        const has = g.selected.includes(value);
        if (g.multiple) {
          return { ...g, selected: has ? g.selected.filter((v) => v !== value) : [...g.selected, value] };
        }
        return { ...g, selected: has ? [] : [value] };
      })
    });
  };

  const toggleRow = (id: string): void => {
    update({
      ...draft,
      toggles: draft.toggles.map((t) => (t.id === id ? { ...t, checked: !t.checked } : t))
    });
  };

  const dirty = !chipGroupsEqual(draft.groups, groups) || !togglesEqual(draft.toggles, toggles);
  const label = resultCount !== null ? `Show ${resultCount} ${resultNoun}` : dirty ? `Apply filters` : `Show all ${resultNoun}`;

  return (
    <div className="md:hidden">
      <MobileSheet
        open={open}
        onClose={onClose}
        title={title}
        footer={
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="h-12 w-24 flex-none rounded-[12px] border border-border bg-surface-raised text-[15px] text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onApply(draft);
                onClose();
              }}
              className="h-12 flex-1 rounded-[12px] bg-brand text-[15px] font-medium text-text-inverse transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {label}
            </button>
          </div>
        }
      >
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              const cleared: FilterDraft = {
                groups: draft.groups.map((g) => ({ ...g, selected: [] })),
                toggles: draft.toggles.map((t) => ({ ...t, checked: false }))
              };
              setDraft(cleared);
              onReset();
              onDraftChange?.(cleared, { groups, toggles });
            }}
            className="h-11 rounded-control px-2 text-sm text-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Reset
          </button>
        </div>

        {draft.groups.map((group) => (
          <div key={group.id} className="pt-4">
            <p className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">
              {group.label}
            </p>
            <div className="flex flex-wrap gap-2">
              {group.options.map((option) => {
                const selected = group.selected.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleChip(group.id, option.value)}
                    className={cn(
                      "h-[38px] rounded-[10px] px-3.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                      selected
                        ? "bg-brand font-medium text-text-inverse"
                        : "border border-border bg-surface-raised text-[#c3d3ec] hover:border-border-strong"
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {draft.toggles.length > 0 && (
          <div className="pt-5">
            {draft.toggles.map((toggle, index) => (
              <div
                key={toggle.id}
                className={cn("flex h-11 items-center justify-between", index > 0 && "border-t border-border/60")}
              >
                <span className="text-[15px] text-text">{toggle.label}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={toggle.checked}
                  aria-label={toggle.label}
                  onClick={() => toggleRow(toggle.id)}
                  className={cn(
                    "flex h-6 w-10 flex-none items-center rounded-[12px] p-[3px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                    toggle.checked ? "justify-end bg-brand" : "justify-start bg-border"
                  )}
                >
                  <span
                    className={cn(
                      "block h-[18px] w-[18px] rounded-full",
                      toggle.checked ? "bg-text-inverse" : "bg-text-muted"
                    )}
                  />
                </button>
              </div>
            ))}
          </div>
        )}
      </MobileSheet>
    </div>
  );
}

/** Count of non-default filters for the badge ("Filters 2"). */
export function countActiveFilters(
  groups: FilterChipGroup[],
  toggles: FilterToggleRow[],
  defaults: Record<string, string[]> = {}
): number {
  let count = 0;
  for (const g of groups) {
    const def = defaults[g.id] ?? [];
    const active = g.selected.filter((v) => !def.includes(v));
    count += g.multiple ? active.length : active.length > 0 ? 1 : 0;
  }
  for (const t of toggles) {
    if (t.checked) count += 1;
  }
  return count;
}
