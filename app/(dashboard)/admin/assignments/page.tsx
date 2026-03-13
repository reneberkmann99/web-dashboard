"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

type AssignmentPayload = {
  assignments: Array<{
    id: string;
    dockerName: string;
    dockerContainerId: string;
    image: string | null;
    isActive: boolean;
    clientAccount: { name: string };
    node: { name: string };
    project: { name: string } | null;
    allowedActions: string[];
  }>;
  clients: Array<{ id: string; name: string }>;
  nodes: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
};

export default function AdminAssignmentsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [clientAccountId, setClientAccountId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [dockerContainerId, setDockerContainerId] = useState("");
  const [dockerName, setDockerName] = useState("");
  const [image, setImage] = useState("");
  const [friendlyLabel, setFriendlyLabel] = useState("");

  const query = useQuery({
    queryKey: ["admin-assignments"],
    queryFn: () => apiFetch<AssignmentPayload>("/api/admin/assignments")
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>("/api/admin/assignments", {
        method: "POST",
        body: JSON.stringify({
          clientAccountId,
          nodeId,
          projectId: projectId || null,
          dockerContainerId,
          dockerName,
          image,
          friendlyLabel,
          allowedActions: ["start", "stop", "restart"]
        })
      }),
    onSuccess: () => {
      toast.success("Assignment created");
      setDockerContainerId("");
      setDockerName("");
      setImage("");
      setFriendlyLabel("");
      queryClient.invalidateQueries({ queryKey: ["admin-assignments"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Assignment failed")
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean }>(`/api/admin/assignments/${id}`, {
        method: "DELETE"
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-assignments"] })
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    createMutation.mutate();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Container assignments</h1>
        <p className="text-muted">Map discovered containers to client-visible projects and permissions.</p>
      </div>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Create assignment</CardTitle>
          <CardDescription>Client users only see assigned active containers.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 md:grid-cols-4" onSubmit={submit}>
            <Select value={clientAccountId} onChange={(event) => setClientAccountId(event.target.value)} required>
              <option value="">Select client</option>
              {(query.data?.clients ?? []).map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
            <Select value={nodeId} onChange={(event) => setNodeId(event.target.value)} required>
              <option value="">Select node</option>
              {(query.data?.nodes ?? []).map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
            </Select>
            <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">Optional project</option>
              {(query.data?.projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
            <Input placeholder="Container ID" value={dockerContainerId} onChange={(event) => setDockerContainerId(event.target.value)} required />
            <Input placeholder="Container name" value={dockerName} onChange={(event) => setDockerName(event.target.value)} required />
            <Input placeholder="Image" value={image} onChange={(event) => setImage(event.target.value)} />
            <Input placeholder="Friendly label" value={friendlyLabel} onChange={(event) => setFriendlyLabel(event.target.value)} />
            <div className="md:col-span-4">
              <Button type="submit">Create assignment</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Assignments</CardTitle>
          <CardDescription>Only active assignments are shown to clients.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="pb-2">Container</th>
                <th className="pb-2">Client</th>
                <th className="pb-2">Node</th>
                <th className="pb-2">Project</th>
                <th className="pb-2">Allowed</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(query.data?.assignments ?? []).map((assignment) => (
                <tr className="border-t border-border" key={assignment.id}>
                  <td className="py-3">
                    <p>{assignment.dockerName}</p>
                    <p className="text-xs text-muted">{assignment.dockerContainerId}</p>
                  </td>
                  <td className="py-3">{assignment.clientAccount.name}</td>
                  <td className="py-3">{assignment.node.name}</td>
                  <td className="py-3">{assignment.project?.name ?? "-"}</td>
                  <td className="py-3">{assignment.allowedActions.join(", ")}</td>
                  <td className="py-3">
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        if (window.confirm("Delete this assignment?")) {
                          deleteMutation.mutate(assignment.id);
                        }
                      }}
                    >
                      Delete
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
