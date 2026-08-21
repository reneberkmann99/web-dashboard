"use client";

import { cn } from "@/lib/utils";

/** Labeled form field wrapper used by every structured deployment control. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium uppercase tracking-wide text-text-muted">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-text-subtle">{hint}</p>}
      {error && <p className="text-xs text-critical-foreground">{error}</p>}
    </div>
  );
}

/** Checkbox with an inline description; matches the dark form styling. */
export function CheckField({
  label,
  hint,
  checked,
  onChange,
  disabled
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-control border border-border bg-surface-raised px-3 py-2.5">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
      />
      <span className="min-w-0">
        <span className="block text-sm text-text">{label}</span>
        {hint && <span className="block text-xs text-text-subtle">{hint}</span>}
      </span>
    </label>
  );
}

/** Section container inside a service form. */
export function FormSection({
  title,
  description,
  actions,
  children
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="rounded-panel border border-border bg-surface-raised/40 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-text-subtle">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Repeating row wrapper with a remove affordance. */
export function RepeatRow({
  onRemove,
  removeLabel,
  children
}: {
  onRemove: () => void;
  removeLabel: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-control border border-border/70 bg-surface-hull/40 p-2.5">
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="h-control-sm shrink-0 rounded-control border border-border px-3 text-xs text-text-muted transition-colors hover:border-critical/50 hover:text-critical-foreground"
      >
        Remove
      </button>
    </div>
  );
}
