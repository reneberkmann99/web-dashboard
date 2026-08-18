"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { NodeRecord } from "@/types/domain";

type NodePayload = {
  nodes: NodeRecord[];
};

type EnrollmentResponse = {
  token: string;
  expiresAt: string;
  ttlMinutes: number;
  nodeId: string | null;
};

export default function AdminNodesPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [enrollment, setEnrollment] = useState<EnrollmentResponse | null>(null);

  const query = useQuery({
    queryKey: ["admin-nodes"],
    queryFn: () => apiFetch<NodePayload>("/api/admin/nodes")
  });

  const enrollMutation = useMutation({
    mutationFn: () =>
      apiFetch<EnrollmentResponse>("/api/admin/nodes/enroll-token", {
        method: "POST",
        body: JSON.stringify({})
      }),
    onSuccess: (data) => {
      toast.success("Enrollment token created (valid 15 minutes)");
      setEnrollment(data);
      queryClient.invalidateQueries({ queryKey: ["admin-nodes"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to create token")
  });

  const patchMutation = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) =>
      apiFetch<{ success: boolean }>(`/api/admin/nodes/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: input.isActive })
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-nodes"] })
  });

  const controlPlaneUrl = typeof window !== "undefined" ? window.location.origin : "http://172.28.0.1:1337";

  const enrollmentCommand = enrollment
    ? [
        "docker run -d --name hostpanel-agent \\",
        "  --restart unless-stopped \\",
        `  -e CONTROL_PLANE_URL=${controlPlaneUrl} \\`,
        `  -e AGENT_ENROLL_TOKEN=${enrollment.token} \\`,
        "  -e AGENT_DOCKER_MODE=rootless \\",
        "  -e DOCKER_HOST=unix:///var/run/docker.sock \\",
        "  -e AGENT_KEY_FILE=/data/agent.key \\",
        "  -v /var/run/docker.sock:/var/run/docker.sock:rw \\",
        "  -v hostpanel-agent-data:/data \\",
        "  ghcr.io/reneberkmann99/hostpanel-agent:latest"
      ].join("\n")
    : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Node management</h1>
        <p className="text-muted">Enroll agents — the control plane issues their credentials.</p>
      </div>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Enroll a node</CardTitle>
          <CardDescription>
            Generates a short-lived one-time token. Run the enrollment command on the target host; the agent
            registers itself and receives its own API key. Tokens cannot be reused or re-displayed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button disabled={enrollMutation.isPending} onClick={() => enrollMutation.mutate()}>
            {enrollMutation.isPending ? "Generating…" : "Generate enrollment token"}
          </Button>

          {enrollment && (
            <div className="space-y-3 rounded border border-border bg-panelAlt p-3">
              <p className="text-sm font-medium">
                Run this on the node host (token expires {new Date(enrollment.expiresAt).toLocaleString()}):
              </p>
              <pre className="overflow-x-auto rounded border border-border bg-black/40 p-3 text-xs text-slate-200">
                {enrollmentCommand}
              </pre>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(enrollmentCommand ?? "");
                    toast.success("Command copied");
                  }}
                >
                  Copy command
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setEnrollment(null)}>
                  Dismiss
                </Button>
              </div>
              <p className="text-xs text-muted">
                The raw token is displayed only once. For compose-managed agents (like this host&apos;s), set
                CONTROL_PLANE_URL, AGENT_ENROLL_TOKEN and AGENT_KEY_FILE on the agent service instead.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Nodes</CardTitle>
          <CardDescription>Agent-connected servers in your control plane.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {query.isLoading ? (
            <div className="space-y-3">
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
            </div>
          ) : query.isError ? (
            <p className="text-sm text-red-400">Failed to load nodes.</p>
          ) : !(query.data?.nodes ?? []).length ? (
            <p className="text-sm text-muted">No nodes registered yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="pb-2">Node</th>
                  <th className="pb-2">State</th>
                  <th className="pb-2">Agent / Docker</th>
                  <th className="pb-2">Heartbeat</th>
                  <th className="pb-2">Containers</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(query.data?.nodes ?? []).map((node) => (
                  <tr className="border-t border-border" key={node.id}>
                    <td className="py-3">
                      <p>{node.name}</p>
                      <p className="text-xs text-muted">{node.hostname}</p>
                    </td>
                    <td className="py-3">{node.status}</td>
                    <td className="py-3">
                      <p>{node.agentVersion ?? "-"}</p>
                      <p className="text-xs text-muted">docker {node.dockerVersion ?? "-"}</p>
                    </td>
                    <td className="py-3">
                      {node.lastHeartbeatAt
                        ? new Date(node.lastHeartbeatAt).toLocaleString()
                        : "never"}
                    </td>
                    <td className="py-3">{node._count.assignments}</td>
                    <td className="py-3">
                      <Button
                        disabled={patchMutation.isPending}
                        size="sm"
                        variant={node.isActive ? "danger" : "secondary"}
                        onClick={() => patchMutation.mutate({ id: node.id, isActive: !node.isActive })}
                      >
                        {node.isActive ? "Disable" : "Enable"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
