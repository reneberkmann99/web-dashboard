"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { AssignmentRecord, NameRef, DiscoveredContainer, ProjectRecord } from "@/types/domain";

type AssignmentPayload = {
  assignments: AssignmentRecord[];
  clients: NameRef[];
  nodes: NameRef[];
  projects: NameRef[];
  discovered: DiscoveredContainer[];
};

type ProjectPayload = {
  projects: ProjectRecord[];
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

  // Project creation state
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [projectClientId, setProjectClientId] = useState("");
  const [projectNodeId, setProjectNodeId] = useState("");
  const [projectDescription, setProjectDescription] = useState("");

  const query = useQuery({
    queryKey: ["admin-assignments"],
    queryFn: () => apiFetch<AssignmentPayload>("/api/admin/assignments")
  });

  const projectsQuery = useQuery({
    queryKey: ["admin-projects"],
    queryFn: () => apiFetch<ProjectPayload>("/api/admin/projects")
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
      toast.success("Access granted");
      setDockerContainerId("");
      setDockerName("");
      setImage("");
      setFriendlyLabel("");
      queryClient.invalidateQueries({ queryKey: ["admin-assignments"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Assignment failed")
  });

  const createProjectMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>("/api/admin/projects", {
        method: "POST",
        body: JSON.stringify({
          name: projectName,
          slug: projectSlug,
          description: projectDescription || null,
          clientAccountId: projectClientId,
          nodeId: projectNodeId
        })
      }),
    onSuccess: () => {
      toast.success("Stack created");
      setProjectName("");
      setProjectSlug("");
      setProjectDescription("");
      setProjectClientId("");
      setProjectNodeId("");
      queryClient.invalidateQueries({ queryKey: ["admin-projects", "admin-assignments"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Stack create failed")
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean }>(`/api/admin/assignments/${id}`, {
        method: "DELETE"
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-assignments"] })
  });

  function pickDiscovered(containerId: string): void {
    const found = (query.data?.discovered ?? []).find((c) => c.dockerContainerId === containerId);
    if (!found) {
      return;
    }
    setNodeId(found.nodeId);
    setDockerContainerId(found.dockerContainerId);
    setDockerName(found.dockerName);
    setImage(found.image ?? "");
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    createMutation.mutate();
  }

  function submitProject(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    createProjectMutation.mutate();
  }

  const discoveredByNode = (query.data?.discovered ?? []).filter(
    (c) => !nodeId || c.nodeId === nodeId
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Access grants</h1>
        <p className="text-muted">Grant clients access to discovered containers or whole stacks.</p>
      </div>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Grant container access</CardTitle>
          <CardDescription>
            Pick a container from the discovered inventory — no need to type Docker IDs by hand.
          </CardDescription>
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
              <option value="">Filter node</option>
              {(query.data?.nodes ?? []).map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
            </Select>
            <Select value={dockerContainerId} onChange={(event) => pickDiscovered(event.target.value)} required>
              <option value="">Discovered container…</option>
              {discoveredByNode.map((c) => (
                <option key={`${c.nodeId}:${c.dockerContainerId}`} value={c.dockerContainerId}>
                  {c.dockerName} ({c.nodeName})
                </option>
              ))}
            </Select>
            <Input placeholder="Friendly label (optional)" value={friendlyLabel} onChange={(event) => setFriendlyLabel(event.target.value)} />
            <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">No stack</option>
              {(query.data?.projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
            <div className="md:col-span-4 flex items-end gap-2">
              <Button disabled={createMutation.isPending} type="submit">
                {createMutation.isPending ? "Granting..." : "Grant access"}
              </Button>
              {dockerContainerId && (
                <span className="text-xs text-muted">
                  {dockerName} {image ? `· ${image}` : ""}
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Stacks (Projects)</CardTitle>
          <CardDescription>
            A stack is a logical workload (e.g. Home Assistant, Mailcow, BookStack). Granting access to a stack grants it to all of its containers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form className="grid gap-3 md:grid-cols-6" onSubmit={submitProject}>
            <Input placeholder="Stack name" value={projectName} onChange={(event) => setProjectName(event.target.value)} required />
            <Input placeholder="slug" value={projectSlug} onChange={(event) => setProjectSlug(event.target.value)} required />
            <Select value={projectClientId} onChange={(event) => setProjectClientId(event.target.value)} required>
              <option value="">Client</option>
              {(query.data?.clients ?? []).map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
            <Select value={projectNodeId} onChange={(event) => setProjectNodeId(event.target.value)} required>
              <option value="">Node</option>
              {(query.data?.nodes ?? []).map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
            </Select>
            <Input placeholder="Description (optional)" value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} />
            <Button disabled={createProjectMutation.isPending} type="submit">
              {createProjectMutation.isPending ? "Creating..." : "Create stack"}
            </Button>
          </form>
          {projectsQuery.data?.projects?.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="pb-2">Stack</th>
                  <th className="pb-2">Client</th>
                  <th className="pb-2">Node</th>
                  <th className="pb-2">Containers</th>
                </tr>
              </thead>
              <tbody>
                {projectsQuery.data.projects.map((project) => (
                  <tr className="border-t border-border" key={project.id}>
                    <td className="py-3">
                      <p>{project.name}</p>
                      <p className="text-xs text-muted">{project.description ?? project.slug}</p>
                    </td>
                    <td className="py-3">{project.clientAccount.name}</td>
                    <td className="py-3">{project.node.name}</td>
                    <td className="py-3">{project._count.containers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted">No stacks yet. Create one to group containers.</p>
          )}
        </CardContent>
      </Card>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Active grants</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {query.isLoading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : !(query.data?.assignments ?? []).length ? (
            <p className="text-sm text-muted">No grants yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="pb-2">Client</th>
                  <th className="pb-2">Container</th>
                  <th className="pb-2">Node</th>
                  <th className="pb-2">Stack</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(query.data?.assignments ?? []).map((assignment) => (
                  <tr className="border-t border-border" key={assignment.id}>
                    <td className="py-3">{assignment.clientAccount.name}</td>
                    <td className="py-3">
                      {assignment.dockerName}
                      <p className="text-xs text-muted">{assignment.dockerContainerId}</p>
                    </td>
                    <td className="py-3">{assignment.node.name}</td>
                    <td className="py-3">{assignment.project?.name ?? "—"}</td>
                    <td className="py-3">
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => deleteMutation.mutate(assignment.id)}
                      >
                        Revoke
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
