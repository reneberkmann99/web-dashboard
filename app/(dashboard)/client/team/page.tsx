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
import { Select } from "@/components/ui/select";
import { timeAgo } from "@/lib/format";
import { roleLabel, type UserRole } from "@/types/domain";
import { PageHeader } from "@/components/ui/page-header";
import { Menu } from "@/components/ui/menu";
import { userCard } from "@/components/mobile/mobile-resource-cards";

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

type InviteResponse = { id: string; activationUrl: string; activationExpiresAt: string; emailDelivery: { status: "SENT" | "DISABLED" | "FAILED"; message: string } };
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
  const [emailDelivery, setEmailDelivery] = useState<InviteResponse["emailDelivery"] | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; name: string; isActive: boolean } | null>(null);
  const [removeMember, setRemoveMember] = useState<TeamUser | null>(null);
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
      data.emailDelivery.status === "SENT" ? toast.success("Invitation email sent") : toast.error("Invitation created — email was not sent");
      setActivationUrl(data.activationUrl);
      setEmailDelivery(data.emailDelivery);
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
      data.emailDelivery.status === "SENT" ? toast.success("Invitation email reissued") : toast.error("Invitation reissued — email was not sent");
      setReissueFor(null);
      setActivationUrl(data.activationUrl);
      setEmailDelivery(data.emailDelivery);
      setInviteOpen(true);
      queryClient.invalidateQueries({ queryKey: ["client-team"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to reissue")
  });

  const roleMutation = useMutation({
    mutationFn: (input: { id: string; role: string }) =>
      apiFetch<{ success: boolean }>(`/api/client/team/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: input.role })
      }),
    onSuccess: () => { toast.success("Member role updated; their sessions were invalidated"); queryClient.invalidateQueries({ queryKey: ["client-team"] }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not change role")
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => apiFetch<{ removed: boolean }>(`/api/client/team/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Membership removed"); setRemoveMember(null); queryClient.invalidateQueries({ queryKey: ["client-team"] }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not remove membership")
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
      render: (u) => u.role === "CLIENT_OPERATOR" || u.role === "CLIENT_VIEWER" ? (
        <Select value={u.role} aria-label={`Role for ${u.displayName}`} onChange={(event) => roleMutation.mutate({ id: u.id, role: event.target.value })}>
          {ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      ) : <span className="text-sm">{roleLabel(u.role)}</span>
    },
    {
      key: "status",
      header: "Status",
      render: (u) =>
        u.pending ? (
          <Badge variant="warning">pending</Badge>
        ) : (
          <Badge variant={u.isActive ? "success" : "neutral"}>{u.isActive ? "active" : "inactive"}</Badge>
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
          {!u.pending && (u.role === "CLIENT_OPERATOR" || u.role === "CLIENT_VIEWER") && <Menu label={`Actions for ${u.displayName}`} items={[
            {
              label: u.isActive ? "Deactivate member" : "Reactivate member",
              tone: u.isActive ? ("danger" as const) : ("default" as const),
              onSelect: () => setConfirm({ id: u.id, name: u.displayName, isActive: !u.isActive })
            }, {
              label: "Remove membership",
              tone: "danger" as const,
              onSelect: () => setRemoveMember(u)
            }]}/>
          }
        </div>
      )
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Access"
        title="Members"
        description="Manage who can access your organization&apos;s workloads."
        actions={<Button onClick={() => { setInviteOpen(true); setActivationUrl(null); setInviteEmail(""); setInviteName(""); }}>
          Invite user
        </Button>}
      />

      <DataTable
        columns={columns}
        rows={users}
        searchableText={(u) => `${u.displayName} ${u.email}`}
        searchPlaceholder="Search members…"
        loading={query.isLoading}
        error={query.isError ? "Failed to load team" : null}
        emptyTitle="No members yet"
        emptyBody="Invite operators and viewers to give them access to your workloads."
        rowKey={(u) => u.id}
        stateKey="client-team"
        mobileCard={(u: TeamUser) =>
          userCard(
            {
              id: u.id,
              email: u.email,
              displayName: u.displayName,
              role: u.role as UserRole,
              isActive: u.isActive,
              pending: u.pending,
              clientAccountId: null,
              clientAccount: null,
              lastLoginAt: u.lastLoginAt,
              authSource: u.authSource
            },
            <Menu
              label={`Actions for ${u.displayName}`}
              items={[
                ...(u.pending ? [{ label: "Reissue invite", onSelect: () => reissueMutation.mutate(u.id) }] : []),
                ...(u.role === "CLIENT_OPERATOR" || u.role === "CLIENT_VIEWER" ? [{
                  label: u.isActive ? "Deactivate user" : "Activate user",
                  tone: u.isActive ? ("danger" as const) : ("default" as const),
                  onSelect: () => setConfirm({ id: u.id, name: u.displayName, isActive: !u.isActive })
                }, { label: "Remove membership", tone: "danger" as const, onSelect: () => setRemoveMember(u) }] : [])
              ]}
            />
          )
        }
      />

      <Modal
        open={inviteOpen}
        onClose={() => { setInviteOpen(false); setActivationUrl(null); setEmailDelivery(null); }}
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
              <Button onClick={() => { setInviteOpen(false); setActivationUrl(null); setEmailDelivery(null); setReissueFor(null); }}>Done</Button>
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
          <div className="space-y-2"><p className={emailDelivery?.status === "SENT" ? "text-sm text-success-foreground" : "text-sm text-warning-foreground"}>{emailDelivery?.status === "SENT" ? "Invitation email sent." : `Email was not sent${emailDelivery ? `: ${emailDelivery.message}` : ""}. Share this link manually.`}</p><p className="break-all text-sm text-muted">{window.location.origin}{activationUrl}</p></div>
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
              <Select id="team-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </Select>
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

      <ConfirmDialog
        open={removeMember !== null}
        onClose={() => setRemoveMember(null)}
        onConfirm={() => { if (removeMember) removeMutation.mutate(removeMember.id); }}
        title={`Remove ${removeMember?.displayName ?? "this member"} from the organization?`}
        impact="Their organization access, sessions, and unused activation token are revoked. Their platform identity and audit history remain."
        confirmLabel="Remove membership"
        danger
      />
    </div>
  );
}
