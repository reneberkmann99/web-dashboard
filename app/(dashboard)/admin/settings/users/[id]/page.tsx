"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { formatDateTime, humanizeAction, timeAgo } from "@/lib/format";
import { roleLabel, type UserRole } from "@/types/domain";
import { PageHeader } from "@/components/ui/page-header";
import { TabBar } from "@/components/ui/tab-bar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ActivityTimeline } from "@/components/activity/activity-timeline";

type DetailUser = {
  id: string; email: string; displayName: string; role: UserRole; isActive: boolean;
  authSource: "LOCAL" | "PAM"; pamUsername: string | null; lastLoginAt: string | null;
  createdAt: string; clientAccountId: string | null; clientAccount: { id: string; name: string } | null;
  pending: boolean; activationToken: { expiresAt: string; usedAt: string | null } | null;
  sessions: Array<{ id: string; createdAt: string; lastUsedAt: string | null; expiresAt: string }>;
};
type DetailPayload = {
  user: DetailUser;
  activity: Array<{ id: string; action: string; actorEmail: string | null; targetType: string; targetId: string | null; result: string; createdAt: string; metadata: Record<string, unknown> | null }>;
};
type UsersPayload = { clients: Array<{ id: string; name: string }> };
const TABS = ["Overview", "Access", "Security", "Activity"] as const;
const ROLES: Array<{ value: UserRole; label: string }> = [
  { value: "ADMIN", label: "Platform Admin" },
  { value: "CLIENT_ADMIN", label: "Organization Admin" },
  { value: "CLIENT_OPERATOR", label: "Organization Operator" },
  { value: "CLIENT_VIEWER", label: "Organization Viewer" }
];

function status(user: DetailUser): React.JSX.Element {
  if (user.isActive) return <Badge variant="success">Active</Badge>;
  if (user.pending) return <Badge variant="warning">Pending activation</Badge>;
  return <Badge variant="danger">Deactivated</Badge>;
}

export default function AdminUserDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [confirm, setConfirm] = useState<"deactivate" | "delete" | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);

  const detail = useQuery({ queryKey: ["admin-user", id], queryFn: () => apiFetch<DetailPayload>(`/api/admin/users/${id}`) });
  const refs = useQuery({ queryKey: ["admin-user-refs"], queryFn: () => apiFetch<UsersPayload>("/api/admin/users") });
  const user = detail.data?.user;
  // `CLIENT` is a legacy stored enum value. Editing it upgrades it to the
  // explicit Organization Admin role without exposing legacy terminology.
  const selectedRole = role ?? (user?.role === "CLIENT" ? "CLIENT_ADMIN" : user?.role) ?? "CLIENT_OPERATOR";
  const selectedOrganizationId = organizationId ?? user?.clientAccountId ?? "";

  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ["admin-user", id] }); void queryClient.invalidateQueries({ queryKey: ["admin-users"] }); };
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiFetch(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => { toast.success("User access updated; existing sessions were invalidated"); setRole(null); setOrganizationId(null); refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Update failed")
  });
  const reinvite = useMutation({
    mutationFn: () => apiFetch<{ activationUrl: string }>(`/api/admin/users/${id}/resend-activation`, { method: "POST" }),
    onSuccess: async (data) => { await navigator.clipboard.writeText(`${window.location.origin}${data.activationUrl}`); toast.success("New activation link copied"); refresh(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not reissue invitation")
  });
  const remove = useMutation({
    mutationFn: () => apiFetch(`/api/admin/users/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("User deleted; audit history was retained"); router.push("/admin/settings/users"); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Delete failed")
  });

  if (detail.isLoading) return <div className="h-44 animate-pulse rounded-panel border border-border bg-surface-deck" />;
  if (!user) return <p className="text-sm text-critical-foreground">User not found or could not be loaded.</p>;
  const isOrganizationRole = selectedRole !== "ADMIN";

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Platform identity" title={user.displayName} description={user.email} actions={<Button variant="secondary" onClick={() => router.push("/admin/settings/users")}>Back to All Users</Button>} />
      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{roleLabel(user.role)}</Badge>{status(user)}<span className="text-sm text-muted">Last sign-in {timeAgo(user.lastLoginAt)}</span></div>
      <TabBar tabs={TABS} active={tab} onChange={setTab} idPrefix="user-detail" />

      {tab === "Overview" && <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle>Identity</CardTitle><CardDescription>Platform account record.</CardDescription></CardHeader><CardContent className="space-y-3 text-sm">
          <p><span className="text-muted">Email</span><br />{user.email}</p>
          <p><span className="text-muted">Authentication</span><br />{user.authSource === "PAM" ? `PAM${user.pamUsername ? ` · ${user.pamUsername}` : ""}` : "Local password"}</p>
          <p><span className="text-muted">Created</span><br />{formatDateTime(user.createdAt)}</p>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Membership</CardTitle><CardDescription>Organization access is separate from the platform identity.</CardDescription></CardHeader><CardContent className="space-y-3 text-sm">
          <p><span className="text-muted">Organization</span><br />{user.clientAccount?.name ?? "No organization membership"}</p>
          <p><span className="text-muted">Organization role</span><br />{user.role === "ADMIN" ? "Not applicable" : roleLabel(user.role)}</p>
          {user.pending && <p className="text-warning-foreground">Awaiting activation{user.activationToken ? ` until ${formatDateTime(user.activationToken.expiresAt)}` : ""}.</p>}
        </CardContent></Card>
      </div>}

      {tab === "Access" && <Card><CardHeader><CardTitle>Access</CardTitle><CardDescription>Changes apply immediately and invalidate all existing sessions for this user.</CardDescription></CardHeader><CardContent className="max-w-xl space-y-4">
        <div className="space-y-1"><label htmlFor="platform-role" className="text-sm text-muted">Platform or organization role</label><Select id="platform-role" value={selectedRole} disabled={user.authSource === "PAM"} onChange={(e) => setRole(e.target.value as UserRole)}>{ROLES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div>
        {isOrganizationRole && <div className="space-y-1"><label htmlFor="platform-organization" className="text-sm text-muted">Organization membership</label><Select id="platform-organization" value={selectedOrganizationId} disabled={user.authSource === "PAM"} onChange={(e) => setOrganizationId(e.target.value)}><option value="">Select organization</option>{(refs.data?.clients ?? []).map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</Select></div>}
        <Button disabled={update.isPending || user.authSource === "PAM" || (isOrganizationRole && !selectedOrganizationId)} onClick={() => update.mutate({ role: selectedRole, clientAccountId: isOrganizationRole ? selectedOrganizationId : null })}>Save access</Button>
        {user.authSource === "PAM" && <p className="text-sm text-muted">PAM identities are administered by the platform host.</p>}
      </CardContent></Card>}

      {tab === "Security" && <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle>Sessions</CardTitle><CardDescription>{user.sessions.length} active session{user.sessions.length === 1 ? "" : "s"}.</CardDescription></CardHeader><CardContent className="space-y-2 text-sm">{user.sessions.length ? user.sessions.map((session) => <p key={session.id} className="rounded border border-border p-2 text-muted">Last used {timeAgo(session.lastUsedAt)} · expires {formatDateTime(session.expiresAt)}</p>) : <p className="text-muted">No active sessions.</p>}</CardContent></Card>
        <Card><CardHeader><CardTitle>Lifecycle</CardTitle><CardDescription>Deactivation revokes access; deletion removes the identity but preserves audit records.</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2">
          {user.pending && <Button variant="secondary" onClick={() => reinvite.mutate()} disabled={reinvite.isPending}>Reissue activation</Button>}
          {user.isActive ? <Button variant="secondary" onClick={() => setConfirm("deactivate")}>Deactivate</Button> : !user.clientAccountId && user.role !== "ADMIN" ? <Button variant="secondary" onClick={() => { setTab("Access"); toast.message("Assign an organization before reactivating this member"); }}>Assign organization</Button> : <Button variant="secondary" onClick={() => update.mutate({ isActive: true })}>Reactivate</Button>}
          <Button variant="danger" onClick={() => setConfirm("delete")}>Delete</Button>
        </CardContent></Card>
      </div>}

      {tab === "Activity" && <ActivityTimeline events={(detail.data?.activity ?? []).map((event) => ({ ...event, humanized: humanizeAction(event.action) }))} emptyTitle="No user activity" emptyBody="Identity and membership events will appear here." />}

      <ConfirmDialog open={confirm === "deactivate"} onClose={() => setConfirm(null)} onConfirm={() => { update.mutate({ isActive: false }); setConfirm(null); }} title={`Deactivate ${user.displayName}?`} impact="All active sessions are invalidated immediately. You can reactivate this account later." confirmLabel="Deactivate" danger />
      <ConfirmDialog open={confirm === "delete"} onClose={() => setConfirm(null)} onConfirm={() => remove.mutate()} title={`Delete ${user.displayName}?`} impact="The identity and all authentication tokens are removed. Audit history remains with its actor snapshot." confirmLabel="Delete user" danger />
    </div>
  );
}
