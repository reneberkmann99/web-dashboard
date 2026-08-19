/**
 * Server-side lifecycle hooks (Next.js instrumentation).
 *
 * Runs once when the Node.js server starts. Hosts the operation-recovery
 * sweep: any Operation left in REQUESTED/QUEUED/RUNNING by a previous process
 * (crash, deploy, restart) is picked up and driven to completion. This makes
 * the async action queue durable across process restarts — a key reliability
 * property of the Operation abstraction.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startOperationSweeper } = await import("@/server/services/operations");
    startOperationSweeper(30_000);
    const { startDeploymentSweeper } = await import("@/server/services/deployment-executor");
    startDeploymentSweeper(30_000);
  }
}
