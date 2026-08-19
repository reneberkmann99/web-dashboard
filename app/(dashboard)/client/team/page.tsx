"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/lib/format";

type TeamUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  authSource: string;
  pending: boolean;
};

type InviteResponse = { id: string; activationUrl: string; activationExpiresAt: string };
type TeamPayload = { users: TeamUser[] };

const ROLE_OPTIONS = [
  { value: "CLIENT_VIEWER", label: "Viewer (read-only)" },
  { value: "CLIENT_OPERATOR", label: "Operator (operate workloads)" }
];

export default function ClientTeamPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState("CLIENT_OPERATOR");
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; name: string; isActive: boolean } | null>(null);
  const [reissueFor, setReissueFor] = useState<TeamUser | null>(null);

  const query = useQuery({
    queryKey: ["client-team"],
    queryFn: () => apiFetch<TeamPayload>("/api/client/team")
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      apiFetch<InviteResponse>("/api/client/team", {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, displayName: inviteName, role: inviteRole })
      }),
    onSuccess: (data) => {
      toast.success("Invitation generated");
      setActivationUrl(data.activationUrl);
      queryClient.invalidateQueries({ queryKey: ["client-team"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Invite failed")
  });

  const deactivateMutation = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) =>
      apiFetch<{ success: boolean }>(`/api/client/team/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: input.isActive })
      }),
    onSuccess: () => {
      toast.success("Updated");
      queryClient.invalidateQueries({ queryKey: ["client-team"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to update user")
  });

  const reissueMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<InviteResponse>(`/api/client/team/${id}`, {
        method: "POST",
        body: JSON.stringify({ action: "reinvite" })
      }),
    onSuccess: (data) => {
      toast.success("Invitation reissued");
      setReissueFor(null);
      setActivationUrl(data.activationUrl);
      setInviteOpen(true);
      queryClient.invalidateQueries({ queryKey: ["client-team"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to reissue")
  });

  const users = query.data?.users ?? [];

  const columns: Column<TeamUser>[] = [
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
    {
      key: "role",
      header: "Role",
      sortValue: (u) => u.role,
      render: (u) => <span className="text-sm">{u.role.replace(/_/g, " ").toLowerCase()}</span>
    },
    {
      key: "status",
      header: "Status",
      render: (u) =>
        u.pending ? (
          <Badge variant="warning">pending</Badge>
        ) : (
          <Badge variant={u.isActive ? "success" : "default"}>{u.isActive ? "active" : "inactive"}</Badge>
        )
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
        <div className="flex justify-end gap-2">
          {u.pending && (
            <Button size="sm" variant="secondary" onClick={() => reissueMutation.mutate(u.id)}>
              Reissue invite
            </Button>
          )}
          {u.isActive && !u.pending && (
            <Button size="sm" variant="danger" onClick={() => setConfirm({ id: u.id, name: u.displayName, isActive: false })}>
              Deactivate
            </Button>
          )}
          {!u.isActive && !u.pending && (
            <Button size="sm" variant="secondary" onClick={() => setConfirm({ id: u.id, name: u.displayName, isActive: true })}>
              Activate
            </Button>
          )}
        </div>
      )
    }
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">Team</h1>
          <p className="text-muted">Manage who can access your organization&apos;s workloads.</p>
        </div>
        <Button onClick={() => { setInviteOpen(true); setActivationUrl(null); setInviteEmail(""); setInviteName(""); }}>
          Invite user
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={users}
        searchableText={(u) => `${u.displayName} ${u.email}`}
        searchPlaceholder="Search team…"
        loading={query.isLoading}
        error={query.isError ? "Failed to load team" : null}
        emptyTitle="No team members yet"
        emptyBody="Invite operators and viewers to give them access to your workloads."
        rowKey={(u) => u.id}
      />

      <Modal
        open={inviteOpen}
        onClose={() => { setInviteOpen(false); setActivationUrl(null); }}
        title={reissueFor ? "Reissue invitation" : "Invite a team member"}
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
              <Button onClick={() => { setInviteOpen(false); setActivationUrl(null); setReissueFor(null); }}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => { setInviteOpen(false); setReissueFor(null); }}>Cancel</Button>
              <Button
                disabled={inviteMutation.isPending || inviteEmail.length < 5 || inviteName.length < 2}
                onClick={() => inviteMutation.mutate()}
              >
                {inviteMutation.isPending ? "Sending…" : "Generate invite"}
              </Button>
            </>
          )
        }
      >
        {activationUrl ? (
          <p className="break-all text-sm text-muted">{window.location.origin}{activationUrl}</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="team-email" className="text-sm text-muted">Email</label>
              <Input id="team-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="person@example.com" />
            </div>
            <div className="space-y-1">
              <label htmlFor="team-name" className="text-sm text-muted">Display name</label>
              <Input id="team-name" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Jane Doe" />
            </div>
            <div className="space-y-1">
              <label htmlFor="team-role" className="text-sm text-muted">Role</label>
              <select id="team-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="w-full rounded-md border border-border bg-panelAlt px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent">
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) deactivateMutation.mutate({ id: confirm.id, isActive: confirm.isActive });
          setConfirm(null);
        }}
        title={`${confirm?.isActive ? "Activate" : "Deactivate"} ${confirm?.name ?? "user"}?`}
        impact={
          confirm?.isActive
            ? "This user will regain access to your workloads."
            : "This user will immediately lose access to your workloads."
        }
        confirmLabel={confirm?.isActive ? "Activate" : "Deactivate"}
      />
    </div>
  );
}
