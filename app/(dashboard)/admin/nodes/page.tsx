"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type NodePayload = {
  nodes: Array<{
    id: string;
    name: string;
    hostname: string;
    apiBaseUrl: string;
    status: "ONLINE" | "OFFLINE" | "UNKNOWN" | "INACTIVE";
    isActive: boolean;
    _count: {
      assignments: number;
    };
  }>;
};

export default function AdminNodesPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("http://127.0.0.1:8081");
  const [apiKey, setApiKey] = useState("agent-dev-key");

  const query = useQuery({
    queryKey: ["admin-nodes"],
    queryFn: () => apiFetch<NodePayload>("/api/admin/nodes")
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>("/api/admin/nodes", {
        method: "POST",
        body: JSON.stringify({ name, hostname, apiBaseUrl, apiKey })
      }),
    onSuccess: () => {
      toast.success("Node added");
      setName("");
      setHostname("");
      queryClient.invalidateQueries({ queryKey: ["admin-nodes"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Node create failed")
  });

  const patchMutation = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) =>
      apiFetch<{ success: boolean }>(`/api/admin/nodes/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: input.isActive })
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-nodes"] })
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    createMutation.mutate();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Node management</h1>
        <p className="text-muted">Track node health and store encrypted agent credentials.</p>
      </div>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Add node</CardTitle>
          <CardDescription>The API key is encrypted before persistence.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 md:grid-cols-4" onSubmit={submit}>
            <Input placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} required />
            <Input placeholder="Hostname" value={hostname} onChange={(event) => setHostname(event.target.value)} required />
            <Input placeholder="API URL" value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} required />
            <Input placeholder="Agent API key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required />
            <div className="md:col-span-4">
              <Button type="submit">Add node</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Nodes</CardTitle>
          <CardDescription>Agent-connected servers in your control plane.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="pb-2">Node</th>
                <th className="pb-2">API</th>
                <th className="pb-2">Status</th>
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
                  <td className="py-3">{node.apiBaseUrl}</td>
                  <td className="py-3">{node.status}</td>
                  <td className="py-3">{node._count.assignments}</td>
                  <td className="py-3">
                    <Button
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
        </CardContent>
      </Card>
    </div>
  );
}
