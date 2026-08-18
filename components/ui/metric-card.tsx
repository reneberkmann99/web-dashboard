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
    <Card className="panel">
      <CardHeader className="pb-1">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={14} className="text-muted" />}
          <CardDescription>{label}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <p className="metric-value">{value}</p>
        {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
      </CardContent>
    </Card>
  );
}
