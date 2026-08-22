"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ServerDataTable } from "@/components/ui/server-data-table";
import type { Column } from "@/components/ui/data-table";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";
import { useResourceNavigation } from "@/components/navigation/navigation-context";
import { clientCard } from "@/components/mobile/mobile-resource-cards";
import { DesktopFilterBar } from "@/components/ui/desktop-filter-bar";
import { Menu } from "@/components/ui/menu";

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

type ClientsPayload = { clients: ClientListRecord[]; total: number; page: number; limit: number; pageCount: number };

const PAGE_SIZE = 25;

export default function AdminClientsPage(): React.JSX.Element {
  const go = useResourceNavigation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [state, setState] = useState(searchParams.get("state") ?? "");
  const page = Math.max(Number(searchParams.get("page") ?? "1"), 1);

  useEffect(() => {
    setSearch(searchParams.get("search") ?? "");
    setState(searchParams.get("state") ?? "");
  }, [searchParams]);

  const syncUrl = useCallback(
    (patch: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      router.push(`/admin/clients?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  const query = useQuery({
    queryKey: ["admin-clients", { search, state, page }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (state) params.set("state", state);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      return apiFetch<ClientsPayload>(`/api/admin/clients?${params.toString()}`);
    }
  });
  const totalQuery = useQuery({
    queryKey: ["admin-clients-total"],
    queryFn: () => apiFetch<ClientsPayload>("/api/admin/clients?page=1&limit=1")
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
        <p className="truncate font-medium text-text">{c.name}<span className="ml-2 font-mono text-[11px] font-normal text-text-subtle">{c.slug}</span></p>
      )
    },
    {
      key: "users",
      header: "Active users",
      className: "text-right",
      omitWhenEmpty: (c) => c.activeUsers === 0,
      sortValue: (c) => c.activeUsers,
      render: (c) => <span className="font-mono text-xs tabular-nums">{c.activeUsers}</span>
    },
    {
      key: "workloads",
      header: "Workloads",
      className: "text-right",
      omitWhenEmpty: (c) => c.workloadCount === 0,
      sortValue: (c) => c.workloadCount,
      render: (c) => <span className="font-mono text-xs tabular-nums">{c.workloadCount}</span>
    },
    {
      key: "containers",
      header: "Containers",
      className: "text-right",
      omitWhenEmpty: (c) => c.containerCount === 0,
      sortValue: (c) => c.containerCount,
      render: (c) => <span className="font-mono text-xs tabular-nums">{c.containerCount}</span>,
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
      omitWhenEmpty: (c) => !c.lastActivity,
      hideBelow: "md",
      render: (c) => (c.lastActivity ? <span className="font-mono text-xs text-muted">{timeAgo(c.lastActivity.createdAt)}</span> : null)
    },
    {
      key: "actions",
      header: "",
      className: "w-10 text-right",
      render: (client) => <Menu label={`Actions for ${client.name}`} items={[
        { label: "Open client", onSelect: () => go({ url: `/admin/clients/${client.id}`, label: client.name, type: "client", id: client.id }) },
        { label: "Copy identifier", onSelect: () => { void navigator.clipboard.writeText(client.id); toast.success("Client ID copied"); } }
      ]} />
    }
  ];

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Tenancy" title="Clients" count={totalQuery.data?.total ?? query.data?.total ?? 0} description="Organizations and their access boundaries." actions={<Button onClick={() => setCreateOpen(true)}>Create client</Button>} />

      <DesktopFilterBar
        search={search}
        onSearchChange={(value) => { setSearch(value); syncUrl({ search: value, page: "1" }); }}
        searchPlaceholder="Search clients…"
        dimensions={[{ id: "state", label: "State", value: state, options: [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }], onChange: (value) => { setState(value); syncUrl({ state: value, page: "1" }); } }]}
        resultCount={query.data?.total ?? 0}
        totalCount={totalQuery.data?.total ?? query.data?.total ?? 0}
        onClearAll={() => { setSearch(""); setState(""); syncUrl({ search: "", state: "", page: "1" }); }}
      />

      <div className="md:hidden">
        <Input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            syncUrl({ search: e.target.value, page: "1" });
          }}
          placeholder="Search clients…"
          aria-label="Search clients"
          className="w-full"
        />
      </div>

      <ServerDataTable
        columns={columns}
        rows={query.data?.clients ?? []}
        total={query.data?.total ?? 0}
        page={query.data?.page ?? page}
        pageSize={PAGE_SIZE}
        onPageChange={(p) => syncUrl({ page: String(p) })}
        loading={query.isLoading}
        error={query.isError ? "Failed to load clients" : null}
        emptyTitle="No clients yet"
        emptyBody="Create a client to represent an organization, then invite users and grant workloads."
        onRowClick={(c) => {
          go({ url: `/admin/clients/${c.id}`, label: c.name, type: "client", id: c.id });
        }}
        rowKey={(c) => c.id}
        mobileCard={(c) =>
          clientCard(c, () => {
            go({ url: `/admin/clients/${c.id}`, label: c.name, type: "client", id: c.id });
          })
        }
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
