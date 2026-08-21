"use client";

import { useRouter } from "next/navigation";
import { CreateWorkloadWizard } from "@/components/workloads/create/create-workload";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Admin "Create workload" — structured Form wizard + Compose YAML (advanced).
 * Both paths author a normal Deployment + DeploymentRevision through the
 * existing admin deployments API; no special "simple workload" backend.
 */
export default function AdminNewWorkloadPage(): React.JSX.Element {
  const router = useRouter();
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        eyebrow="Managed deployment"
        title="New workload"
        back={
          <button
            type="button"
            onClick={() => router.push("/admin/workloads")}
            className="mb-2 text-sm text-brand hover:text-brand-hover"
          >
            ← Workloads
          </button>
        }
        description={
          <span>
            Create a managed workload with the structured form wizard, or paste a Compose document directly. Either
            way the workload is authored as a normal deployment definition — nothing is deployed until you review a
            plan and confirm.
          </span>
        }
      />
      <CreateWorkloadWizard
        tenant="admin"
        backHref="/admin/workloads"
        detailHref={(projectId) => `/admin/workloads/${projectId}`}
      />
    </div>
  );
}
