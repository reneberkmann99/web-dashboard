import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type BreadcrumbItem = {
  label: string;
  href?: string;
};

/**
 * Design-system breadcrumbs (Noderaft Brand.dc.html "page hierarchy"):
 * clickable ancestor segments + a non-link current segment, separated by a
 * muted chevron. Reflects real hierarchy — never a hard-coded fake Back link.
 */
export function Breadcrumbs({
  items,
  className
}: {
  items: BreadcrumbItem[];
  className?: string;
}): React.JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn("flex flex-wrap items-center gap-1 text-sm", className)}>
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <span key={`${item.label}-${index}`} className="flex items-center gap-1">
            {index > 0 && <ChevronRight size={13} className="shrink-0 text-text-subtle" />}
            {item.href && !last ? (
              <Link
                href={item.href}
                className="text-text-muted transition-colors hover:text-text focus:outline-none focus:ring-2 focus:ring-focus"
              >
                {item.label}
              </Link>
            ) : (
              <span className={cn(last ? "font-medium text-text" : "text-text-muted")} aria-current={last ? "page" : undefined}>
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
