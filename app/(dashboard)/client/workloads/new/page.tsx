"use client";

import { useRouter } from "next/navigation";
import { CreateWorkloadWizard } from "@/components/workloads/create/create-workload";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Client self-service: create a new managed workload on one of the account's
 * allowlisted nodes — via the structured Form wizard or Compose YAML
 * (advanced). Authored under STRICT security policy server-side (privileged
 * containers, host binds, host networking/PID/IPC, Docker socket mounts,
 * extra capabilities, devices, external networks/volumes are blocked).
 */
export default function NewClientWorkloadPage(): React.JSX.Element {
  const router = useRouter();
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        eyebrow="Managed deployment"
        title="New workload"
        back={
          <button
            type="button"
            onClick={() => router.push("/organization/workloads")}
            className="mb-2 text-sm text-brand hover:text-brand-hover"
          >
            ← Workloads
          </button>
        }
        description={
          <span>
            Create a managed service with the structured form wizard, or paste a Compose document directly.
            Configurations run under strict policy — no privileged containers, host binds, host networking, Docker
            socket access, extra capabilities, or external network/volume attachment.
          </span>
        }
      />
      <CreateWorkloadWizard
        tenant="client"
        backHref="/organization/workloads"
        detailHref={(projectId) => `/organization/workloads/${projectId}`}
      />
    </div>
  );
}
