"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type ClientRecord = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  _count: {
    users: number;
    assignments: number;
  };
};

export default function AdminClientsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  const query = useQuery({
    queryKey: ["admin-clients"],
    queryFn: () => apiFetch<{ clients: ClientRecord[] }>("/api/admin/clients")
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>("/api/admin/clients", {
        method: "POST",
        body: JSON.stringify({ name, slug })
      }),
    onSuccess: () => {
      toast.success("Client created");
      setName("");
      setSlug("");
      queryClient.invalidateQueries({ queryKey: ["admin-clients"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to create client");
    }
  });

  const patchMutation = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) =>
      apiFetch<{ success: boolean }>(`/api/admin/clients/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: input.isActive })
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-clients"] })
  });

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    createMutation.mutate();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Client management</h1>
        <p className="text-muted">Create, edit, and deactivate client organizations.</p>
      </div>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Create client account</CardTitle>
          <CardDescription>Slug is used for stable references.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 md:grid-cols-4" onSubmit={submit}>
            <Input placeholder="Client name" value={name} onChange={(event) => setName(event.target.value)} required />
            <Input placeholder="slug-like-this" value={slug} onChange={(event) => setSlug(event.target.value)} required />
            <div className="md:col-span-2">
              <Button disabled={createMutation.isPending} type="submit">
                {createMutation.isPending ? "Creating..." : "Create client"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Clients</CardTitle>
          <CardDescription>All registered organizations.</CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="h-10 animate-pulse rounded bg-panelAlt" />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="pb-2">Name</th>
                  <th className="pb-2">Slug</th>
                  <th className="pb-2">Users</th>
                  <th className="pb-2">Containers</th>
                  <th className="pb-2">State</th>
                </tr>
              </thead>
              <tbody>
                {(query.data?.clients ?? []).map((client) => (
                  <tr className="border-t border-border" key={client.id}>
                    <td className="py-3">{client.name}</td>
                    <td className="py-3">{client.slug}</td>
                    <td className="py-3">{client._count.users}</td>
                    <td className="py-3">{client._count.assignments}</td>
                    <td className="py-3">
                      <Button
                        disabled={patchMutation.isPending}
                        size="sm"
                        variant={client.isActive ? "danger" : "secondary"}
                        onClick={() => patchMutation.mutate({ id: client.id, isActive: !client.isActive })}
                      >
                        {client.isActive ? "Deactivate" : "Activate"}
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
