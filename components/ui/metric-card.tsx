import { LucideIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

export function MetricCard({
  label,
  value,
  sub,
  icon: Icon
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon?: LucideIcon;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={14} className="text-text-muted" />}
          <CardDescription>{label}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <p className="metric-value">{value}</p>
        {sub && <p className="mt-2 text-xs text-text-muted">{sub}</p>}
      </CardContent>
    </Card>
  );
}
