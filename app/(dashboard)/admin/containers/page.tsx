"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ContainerView } from "@/types/domain";

type Payload = {
  containers: ContainerView[];
};

export default function AdminContainersPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

  const query = useQuery({
    queryKey: ["admin-containers"],
    queryFn: () => apiFetch<Payload>("/api/admin/containers"),
    refetchInterval: 7000
  });

  const actionMutation = useMutation({
    mutationFn: async (input: { assignmentId: string; action: "start" | "stop" | "restart" }) =>
      apiFetch<{ success: boolean }>(`/api/admin/containers/${input.assignmentId}/action`, {
        method: "POST",
        body: JSON.stringify({ action: input.action })
      }),
    onSuccess: () => {
      toast.success("Action submitted");
      queryClient.invalidateQueries({ queryKey: ["admin-containers"] });
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Action failed")
  });

  const filtered = useMemo(() => {
    const items = query.data?.containers ?? [];
    const q = search.trim().toLowerCase();
    if (!q) {
      return items;
    }

    return items.filter((item) => {
      return (
        item.name.toLowerCase().includes(q) ||
        item.clientName.toLowerCase().includes(q) ||
        item.nodeName.toLowerCase().includes(q) ||
        item.image.toLowerCase().includes(q)
      );
    });
  }, [query.data?.containers, search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">All containers</h1>
          <p className="text-muted">Cross-client runtime view with admin actions.</p>
        </div>
        <Input
          className="w-full max-w-xs"
          placeholder="Search by client, node, image"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Runtime inventory</CardTitle>
          <CardDescription>Server-side authorized controls for assigned containers.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="pb-2">Container</th>
                <th className="pb-2">Client</th>
                <th className="pb-2">Node</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">CPU</th>
                <th className="pb-2">Memory</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((container) => (
                <tr className="border-t border-border" key={container.assignmentId}>
                  <td className="py-3">
                    <p className="font-medium">{container.name}</p>
                    <p className="text-xs text-muted">{container.image}</p>
                  </td>
                  <td className="py-3">{container.clientName}</td>
                  <td className="py-3">
                    <p>{container.nodeName}</p>
                    {!container.nodeOnline ? <Badge variant="danger">offline</Badge> : null}
                  </td>
                  <td className="py-3">
                    <StatusBadge status={container.status} />
                  </td>
                  <td className="py-3">{container.cpuPercent !== null ? `${container.cpuPercent.toFixed(2)}%` : "-"}</td>
                  <td className="py-3">{container.memoryUsage ?? "-"}</td>
                  <td className="py-3">
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => actionMutation.mutate({ assignmentId: container.assignmentId, action: "start" })}>
                        start
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => actionMutation.mutate({ assignmentId: container.assignmentId, action: "restart" })}>
                        restart
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          if (window.confirm("Stop this container?")) {
                            actionMutation.mutate({ assignmentId: container.assignmentId, action: "stop" });
                          }
                        }}
                      >
                        stop
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
