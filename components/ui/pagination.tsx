import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shared design-system pagination. A single "X–Y of N" summary with Prev/Next
 * controls — used consistently by large data sets (Containers, Organizations, Users,
 * Activity, notification delivery history, release history) so no page ships
 * its own subtly-different pagination footer.
 */
export function Pagination({
  start,
  end,
  total,
  page,
  pageCount,
  onPageChange
}: {
  start: number;
  end: number;
  total: number;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}): React.JSX.Element {
  const safePage = Math.min(Math.max(page, 1), Math.max(pageCount, 1));
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-text-muted">
      <span className="font-mono text-xs">
        {total > 0 ? `${start}–${end} of ${total}` : "0 results"}
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft size={14} />
        </Button>
        <span className="font-mono text-xs">
          {safePage} / {pageCount}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={safePage >= pageCount}
          onClick={() => onPageChange(safePage + 1)}
          aria-label="Next page"
        >
          <ChevronRight size={14} />
        </Button>
      </div>
    </div>
  );
}
