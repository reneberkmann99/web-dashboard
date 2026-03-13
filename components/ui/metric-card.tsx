import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

export function MetricCard({ label, value }: { label: string; value: string | number }): React.JSX.Element {
  return (
    <Card className="panel">
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="metric-value">{value}</p>
      </CardContent>
    </Card>
  );
}
