"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { TabBar } from "@/components/ui/tab-bar";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { timeAgo } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";
import { Menu } from "@/components/ui/menu";
import { Breadcrumbs } from "@/components/navigation/breadcrumbs";
import { useOptionalNavigation, useResourceNavigation } from "@/components/navigation/navigation-context";
import { useDetailTab } from "@/components/navigation/view-state";
import { ActivityTimeline } from "@/components/activity/activity-timeline";
import { MobileActivityList } from "@/components/mobile/mobile-activity-list";
import { userCard } from "@/components/mobile/mobile-resource-cards";
import { CardChip } from "@/components/mobile/mobile-resource-card";
import { roleLabel } from "@/types/domain";

type ClientDetailPayload = {
  client: {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    createdAt: string;
    users: Array<{
      id: string;
      email: string;
      displayName: string;
      role: string;
      isActive: boolean;
      lastLoginAt: string | null;
      authSource: string;
    }>;
    projects: Array<{
      id: string;
      name: string;
      slug: string;
      description: string | null;
      node: { name: string };
      _count: { containers: number };
    }>;
    grants: Array<{
      id: string;
      allowedActions: string[];
      node: { name: string };
      project: { id: string; name: string } | null;
      container: { id: string; dockerName: string; dockerContainerId: string } | null;
    }>;
    counts: { users: number; projects: number; grants: number };
  };
  activity: Array<{ id: string; action: string; humanized: string; actorEmail: string | null; result: string; createdAt: string }>;
};

type CreateUserResponse = { id: string; activationUrl: string; activationExpiresAt: string; emailDelivery: { status: "SENT" | "DISABLED" | "FAILED"; message: string } };

const ROLE_OPTIONS = [
  { value: "CLIENT_VIEWER", label: "Organization Viewer (read-only)" },
  { value: "CLIENT_OPERATOR", label: "Organization Operator (operate workloads)" },
  { value: "CLIENT_ADMIN", label: "Organization admin (manage members)" }
];

const TABS = ["Overview", "Members", "Workloads", "Activity", "Settings"] as const;

export default function AdminClientDetailPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [tab, setTab] = useDetailTab(TABS, "Overview");
  const nav = useOptionalNavigation();
  const go = useResourceNavigation();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState("CLIENT_OPERATOR");
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const [emailDelivery, setEmailDelivery] = useState<CreateUserResponse["emailDelivery"] | null>(null);

  const [deactivateUser, setDeactivateUser] = useState<{ id: string; name: string } | null>(null);
  const [deactivateClient, setDeactivateClient] = useState(false);

  const query = useQuery({
    queryKey: ["client", params.id],
    queryFn: () => apiFetch<ClientDetailPayload>(`/api/admin/clients/${params.id}`),
    refetchInterval: 15000
  });

  useEffect(() => {
    const name = query.data?.client?.name;
    if (name) nav?.renameCurrent(name);
  }, [query.data?.client?.name, nav]);

  const inviteMutation = useMutation({
    mutationFn: () =>
      apiFetch<CreateUserResponse>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email: inviteEmail,
          displayName: inviteName,
          role: inviteRole,
          clientAccountId: params.id
        })
      }),
    onSuccess: (data) => {
      data.emailDelivery.status === "SENT" ? toast.success("Invitation email sent") : toast.error("Invitation created — email was not sent");
      setActivationUrl(data.activationUrl);
      setEmailDelivery(data.emailDelivery);
      queryClient.invalidateQueries({ queryKey: ["client", params.id] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Invite failed")
  });

  const deactivateUserMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean }>(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ isActive: false }) }),
    onSuccess: () => {
      toast.success("User deactivated");
      queryClient.invalidateQueries({ queryKey: ["client", params.id] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to deactivate")
  });

  const deactivateClientMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>(`/api/admin/clients/${params.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Organization deactivated");
      router.push("/organizations");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to deactivate")
  });

  const revokeGrantMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean }>(`/api/admin/grants/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Grant revoked");
      queryClient.invalidateQueries({ queryKey: ["client", params.id] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to revoke grant")
  });

  if (query.isLoading) return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  if (query.isError || !query.data) return <p className="text-sm text-critical-foreground">Failed to load organization.</p>;

  const { client, activity } = query.data;

  const userColumns: Column<(typeof client.users)[number]>[] = [
    {
      key: "name",
      header: "User",
      render: (u) => (
        <div>
          <p className="font-medium">{u.displayName}</p>
          <p className="text-xs text-muted">{u.email}</p>
        </div>
      )
    },
    { key: "role", header: "Role", sortValue: (u) => u.role, render: (u) => <span className="text-sm">{roleLabel(u.role)}</span> },
    {
      key: "status",
      header: "Status",
      render: (u) => <Badge variant={u.isActive ? "success" : "neutral"}>{u.isActive ? "active" : u.authSource === "PAM" ? "pam" : "pending"}</Badge>
    },
    {
      key: "lastLogin",
      header: "Last login",
      sortValue: (u) => u.lastLoginAt ?? "",
      render: (u) => <span className="text-xs text-muted">{timeAgo(u.lastLoginAt)}</span>,
      hideBelow: "sm"
    },
    {
      key: "actions",
      header: "",
      render: (u) => (
        <div className="flex justify-end">
          {u.isActive && <Menu label={`Actions for ${u.displayName}`} items={[{ label: "Deactivate user", tone: "danger", onSelect: () => setDeactivateUser({ id: u.id, name: u.displayName }) }]} />}
        </div>
      )
    }
  ];

  const grantColumns: Column<(typeof client.grants)[number]>[] = [
    {
      key: "target",
      header: "Target",
      render: (g) => (
        <div>
          <p className="font-medium">{g.project?.name ?? g.container?.dockerName ?? "—"}</p>
          <p className="text-xs text-muted">{g.project ? "Workload" : "Container"} · {g.node.name}</p>
        </div>
      )
    },
    {
      key: "actions",
      header: "Permissions",
      render: (g) => <span className="text-sm text-muted">{g.allowedActions.join(", ")}</span>
    },
    {
      key: "revoke",
      header: "",
      render: (g) => (
        <div className="flex justify-end"><Menu label="Permission actions" items={[{ label: "Revoke permission", tone: "danger", onSelect: () => revokeGrantMutation.mutate(g.id) }]} /></div>
      )
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Organization"
        title={client.name}
        back={<Breadcrumbs />}
        description={<div className="flex flex-wrap items-center gap-2"><span className="font-mono text-sm">{client.slug}</span><span>· {client.counts.users} users · {client.counts.projects} workloads</span><Badge variant={client.isActive ? "success" : "neutral"}>{client.isActive ? "active" : "inactive"}</Badge></div>}
        actions={<>
          <Button variant="ghost" onClick={() => router.push(`/admin/activity?clientId=${client.id}`)}>
            View activity
          </Button>
          {client.isActive && <Menu label={`Actions for ${client.name}`} items={[{ label: "Deactivate organization", tone: "danger", onSelect: () => setDeactivateClient(true) }]} />}
        </>}
      />

      {/* Tab bar — above the panels so its position never shifts with content height */}
      <TabBar tabs={TABS} active={tab} onChange={setTab} idPrefix="client" />

      {tab === "Overview" && (
        <div className="grid gap-4 md:grid-cols-3">
          <Metric label="Active members" value={String(client.users.filter((u) => u.isActive).length)} />
          <Metric label="Workloads" value={String(client.projects.length)} />
          <Metric label="Grants" value={String(client.grants.length)} />
        </div>
      )}

      {tab === "Members" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setInviteOpen(true)}>Invite user</Button>
          </div>
          <DataTable
            columns={userColumns}
            rows={client.users}
            searchableText={(u) => `${u.displayName} ${u.email}`}
            searchPlaceholder="Search users…"
            emptyTitle="No users yet"
            emptyBody="Invite a member to give them access to this organization's workloads."
            rowKey={(u) => u.id}
            stateKey={`client:${client.id}:users`}
            ariaLabel="Organization members"
            mobileCard={(u) =>
              userCard({
                id: u.id,
                email: u.email,
                displayName: u.displayName,
                role: u.role as "ADMIN" | "CLIENT" | "CLIENT_ADMIN" | "CLIENT_OPERATOR" | "CLIENT_VIEWER",
                isActive: u.isActive,
                pending: false,
                clientAccountId: client.id,
                clientAccount: { id: client.id, name: client.name }
              })
            }
          />
        </div>
      )}

      {tab === "Workloads" && (
        <DataTable
          columns={[
            { key: "name", header: "Workload", sortValue: (p: (typeof client.projects)[number]) => p.name, render: (p) => <p className="font-medium">{p.name}</p> },
            { key: "node", header: "Node", render: (p: (typeof client.projects)[number]) => <span className="text-sm">{p.node.name}</span>, hideBelow: "sm" },
            { key: "containers", header: "Containers", sortValue: (p: (typeof client.projects)[number]) => p._count.containers, render: (p: (typeof client.projects)[number]) => <span className="text-sm">{p._count.containers}</span> },
          ]}
          rows={client.projects}
          searchableText={(p) => p.name}
          searchPlaceholder="Search workloads…"
          emptyTitle="No workloads"
          emptyBody="Grant this organization access to a workload to get started."
          rowKey={(p) => p.id}
          stateKey={`client:${client.id}:workloads`}
          ariaLabel="Organization workloads"
          onRowClick={(p) => {
            go({ url: `/admin/workloads/${p.id}`, label: p.name, type: "workload", id: p.id });
          }}
          mobileCard={(p) => (
            <div
              role="link"
              tabIndex={0}
              onClick={() => go({ url: `/admin/workloads/${p.id}`, label: p.name, type: "workload", id: p.id })}
              onKeyDown={(e) => {
                if (e.key === "Enter") go({ url: `/admin/workloads/${p.id}`, label: p.name, type: "workload", id: p.id });
              }}
              className="cursor-pointer rounded-[12px] border border-border bg-surface-deck p-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium">{p.name}</p>
                <CardChip tone="neutral">{p._count.containers} containers</CardChip>
              </div>
              <p className="mt-1 font-mono text-[11px] text-text-muted">{p.node.name}</p>
            </div>
          )}
        />
      )}

      {tab === "Activity" && (
        <div className="rounded-lg border border-border bg-panel">
          <div className="max-md:hidden">
            <ActivityTimeline events={activity} resourceName={client.name} emptyText="No activity recorded for this organization." />
          </div>
          <div className="md:hidden">
            <MobileActivityList events={activity} resourceName={client.name} emptyText="No activity recorded for this organization." />
          </div>
        </div>
      )}

      {tab === "Settings" && (
        <div className="rounded-lg border border-border bg-panel p-5 text-sm">
          <h2 className="font-medium">Organization settings</h2>
          <p className="mt-1 text-muted">Manage organization identity, access, and lifecycle from this detail surface.</p>
          <p className="mt-4 text-muted">Status: <span className="text-text">{client.isActive ? "active" : "inactive"}</span></p>
        </div>
      )}

      {/* Invite modal */}
      <Modal
        open={inviteOpen}
        onClose={() => {
          setInviteOpen(false);
          setActivationUrl(null);
          setEmailDelivery(null);
        }}
        title={`Invite member to ${client.name}`}
        description="The user receives a one-time activation link and sets their own password."
        footer={
          activationUrl ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(`${window.location.origin}${activationUrl}`);
                  toast.success("Activation link copied");
                }}
              >
                Copy link
              </Button>
              <Button onClick={() => { setInviteOpen(false); setActivationUrl(null); setEmailDelivery(null); setInviteEmail(""); setInviteName(""); }}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button disabled={inviteMutation.isPending || inviteEmail.length < 5 || inviteName.length < 2} onClick={() => inviteMutation.mutate()}>
                {inviteMutation.isPending ? "Sending…" : "Generate invite"}
              </Button>
            </>
          )
        }
      >
        {activationUrl ? (
          <div className="space-y-2"><p className={emailDelivery?.status === "SENT" ? "text-sm text-success-foreground" : "text-sm text-warning-foreground"}>{emailDelivery?.status === "SENT" ? "Invitation email sent." : `Email was not sent${emailDelivery ? `: ${emailDelivery.message}` : ""}. Share this link manually.`}</p><p className="break-all text-sm text-muted">{window.location.origin}{activationUrl}</p></div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="invite-email" className="text-sm text-muted">Email</label>
              <Input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="person@example.com" required />
            </div>
            <div className="space-y-1">
              <label htmlFor="invite-name" className="text-sm text-muted">Display name</label>
              <Input id="invite-name" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Jane Doe" required />
            </div>
            <div className="space-y-1">
              <label htmlFor="invite-role" className="text-sm text-muted">Role</label>
              <Select id="invite-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </Select>
            </div>
          </div>
        )}
      </Modal>

      {/* Deactivate user confirm */}
      <ConfirmDialog
        open={deactivateUser !== null}
        onClose={() => setDeactivateUser(null)}
        onConfirm={() => {
          if (deactivateUser) return deactivateUserMutation.mutate(deactivateUser.id);
        }}
        title={`Deactivate ${deactivateUser?.name ?? "user"}?`}
        impact="This member will immediately lose access to the organization's workloads."
        confirmLabel="Deactivate"
      />

      {/* Deactivate organization confirm */}
      <ConfirmDialog
        open={deactivateClient}
        onClose={() => setDeactivateClient(false)}
        onConfirm={() => deactivateClientMutation.mutate()}
        title={`Deactivate ${client.name}?`}
        impact="All of this organization's members lose access immediately. Grants are preserved but inactive."
        confirmLabel="Deactivate"
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

type NodeOption = { id: string; name: string; hostname: string; status: string; composeSupported: boolean | null };
type AllowedNode = { nodeId: string; name: string; hostname: string; status: string; composeSupported: boolean | null; isActive: boolean };

/**
 * Admin-managed node allowlist for tenant self-service (Phase 7). Empty list
 * = the organization cannot create workloads. Strict security policy is applied at
 * the API layer for every organization-authored deployment, independent of which
 * nodes are allowed here.
 */
function ClientDeploymentNodesTab({ clientId }: { clientId: string }): React.JSX.Element {
  const queryClient = useQueryClient();

  const allowedQuery = useQuery({
    queryKey: ["client-node-access", clientId],
    queryFn: () => apiFetch<{ data: AllowedNode[]; total: number }>(`/api/admin/clients/${clientId}/nodes`)
  });
  const allNodesQuery = useQuery({
    queryKey: ["admin-nodes-picker"],
    queryFn: () => apiFetch<{ nodes: NodeOption[] }>("/api/admin/nodes")
  });

  const setNodes = useMutation({
    mutationFn: (nodeIds: string[]) =>
      apiFetch<{ nodeIds: string[] }>(`/api/admin/clients/${clientId}/nodes`, {
        method: "PUT",
        body: JSON.stringify({ nodeIds })
      }),
    onSuccess: () => {
      toast.success("Deployment node access updated");
      queryClient.invalidateQueries({ queryKey: ["client-node-access", clientId] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to update node access")
  });

  if (allowedQuery.isLoading || allNodesQuery.isLoading) {
    return <div className="h-40 animate-pulse rounded-lg bg-panelAlt" />;
  }
  if (allowedQuery.isError || allNodesQuery.isError || !allowedQuery.data || !allNodesQuery.data) {
    return <p className="text-sm text-critical-foreground">Failed to load node access.</p>;
  }

  const allowedIds = new Set(allowedQuery.data.data.map((n) => n.nodeId));
  const toggle = (nodeId: string, checked: boolean): void => {
    const next = new Set(allowedIds);
    if (checked) next.add(nodeId);
    else next.delete(nodeId);
    setNodes.mutate(Array.from(next));
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-panel p-4 text-sm">
        <p className="font-medium">Self-service deployment nodes</p>
        <p className="mt-1 text-muted">
          Nodes checked below are where this organization&apos;s members may create and deploy their own managed workloads.
          Unchecking a node does not affect workloads already deployed there — it only blocks new deployments.
          Organization-authored configurations always run under strict policy: no privileged containers, host binds, host
          networking/PID/IPC, Docker socket mounts, extra capabilities, devices, or external network/volume
          attachment — regardless of which nodes are allowed.
        </p>
      </div>

      {allNodesQuery.data.nodes.length === 0 ? (
        <p className="text-sm text-muted">No nodes registered yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-panel">
          {allNodesQuery.data.nodes.map((n) => (
            <li key={n.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="font-medium">{n.name}</p>
                <p className="text-xs text-muted">
                  {n.hostname} · {n.status}
                  {n.composeSupported === false && " · Compose unavailable"}
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowedIds.has(n.id)}
                  onChange={(e) => toggle(n.id, e.target.checked)}
                  disabled={setNodes.isPending}
                />
                Allowed
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
