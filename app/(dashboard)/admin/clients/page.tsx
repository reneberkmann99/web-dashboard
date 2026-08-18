"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/lib/format";

type ClientListRecord = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  activeUsers: number;
  workloadCount: number;
  containerCount: number;
  lastActivity: { action: string; createdAt: string; result: string } | null;
};

type ClientsPayload = { clients: ClientListRecord[] };

export default function AdminClientsPage(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  const query = useQuery({
    queryKey: ["admin-clients"],
    queryFn: () => apiFetch<ClientsPayload>("/api/admin/clients")
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>("/api/admin/clients", {
        method: "POST",
        body: JSON.stringify({ name, slug: slug || slugify(name) })
      }),
    onSuccess: (data) => {
      toast.success("Client created");
      setCreateOpen(false);
      setName("");
      setSlug("");
      setSlugTouched(false);
      queryClient.invalidateQueries({ queryKey: ["admin-clients"] });
      router.push(`/admin/clients/${data.id}`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Create failed")
  });

  const columns: Column<ClientListRecord>[] = [
    {
      key: "name",
      header: "Client",
      sortValue: (c) => c.name,
      render: (c) => (
        <div>
          <p className="font-medium">{c.name}</p>
          <p className="text-xs text-muted">{c.slug}</p>
        </div>
      )
    },
    {
      key: "users",
      header: "Active users",
      sortValue: (c) => c.activeUsers,
      render: (c) => <span className="text-sm">{c.activeUsers}</span>
    },
    {
      key: "workloads",
      header: "Workloads",
      sortValue: (c) => c.workloadCount,
      render: (c) => <span className="text-sm">{c.workloadCount}</span>
    },
    {
      key: "containers",
      header: "Containers",
      sortValue: (c) => c.containerCount,
      render: (c) => <span className="text-sm">{c.containerCount}</span>,
      hideBelow: "sm"
    },
    {
      key: "state",
      header: "State",
      sortValue: (c) => (c.isActive ? "active" : "inactive"),
      render: (c) => <Badge variant={c.isActive ? "success" : "default"}>{c.isActive ? "active" : "inactive"}</Badge>
    },
    {
      key: "lastActivity",
      header: "Last activity",
      sortValue: (c) => c.lastActivity?.createdAt ?? "",
      hideBelow: "md",
      render: (c) => (c.lastActivity ? <span className="text-xs text-muted">{timeAgo(c.lastActivity.createdAt)}</span> : <span className="text-xs text-muted">—</span>)
    }
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">Clients</h1>
          <p className="text-muted">Organizations and who can access what.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Create client</Button>
      </div>

      <DataTable
        columns={columns}
        rows={query.data?.clients ?? []}
        searchableText={(c) => `${c.name} ${c.slug}`}
        searchPlaceholder="Search clients…"
        loading={query.isLoading}
        error={query.isError ? "Failed to load clients" : null}
        emptyTitle="No clients yet"
        emptyBody="Create a client to represent an organization, then invite users and grant workloads."
        emptyAction={<Button onClick={() => setCreateOpen(true)}>Create client</Button>}
        onRowClick={(c) => router.push(`/admin/clients/${c.id}`)}
        rowKey={(c) => c.id}
      />

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create client"
        description="Represent an organization, then invite its users and grant workloads."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={createMutation.isPending || name.trim().length < 2}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? "Creating…" : "Create client"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="client-name" className="text-sm text-muted">
              Client name
            </label>
            <Input
              id="client-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              placeholder="e.g. Acme Hosting"
              required
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="client-slug" className="text-sm text-muted">
              Identifier (slug)
            </label>
            <Input
              id="client-slug"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              placeholder="acme-hosting"
            />
            <p className="text-xs text-muted">Auto-generated from the name; editable.</p>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
