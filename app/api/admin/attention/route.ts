import { requireApiRole } from "@/server/auth/guards";
import { fromError, ok } from "@/server/http";
import { listAttentionCenter } from "@/server/services/attention-lifecycle";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireApiRole("ADMIN");
    const query = new URL(request.url).searchParams;
    const view = query.get("view");
    const severity = query.get("severity");
    const maintenance = query.get("maintenance");
    const data = await listAttentionCenter({
      view: view === "acknowledged" || view === "silenced" || view === "resolved" ? view : "active",
      severity: severity === "CRITICAL" || severity === "WARNING" || severity === "INFO" ? severity : undefined,
      conditionType: query.get("conditionType") || undefined,
      nodeId: query.get("nodeId") || undefined,
      workloadId: query.get("workloadId") || undefined,
      maintenance: maintenance === "active" || maintenance === "none" ? maintenance : undefined,
      limit: Math.min(Number(query.get("limit") ?? 100) || 100, 200)
    });
    return ok({ conditions: data });
  } catch (error) {
    return fromError(error);
  }
}
