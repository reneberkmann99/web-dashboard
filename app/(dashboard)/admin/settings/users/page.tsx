"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DesktopFilterBar } from "@/components/ui/desktop-filter-bar";
import type { UserRecord, UserRole, NameRef } from "@/types/domain";
import { PageHeader } from "@/components/ui/page-header";
import { Menu } from "@/components/ui/menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { userCard } from "@/components/mobile/mobile-resource-cards";
import { roleLabel } from "@/types/domain";
import { timeAgo } from "@/lib/format";

type UsersPayload = {
  users: UserRecord[];
  clients: NameRef[];
};

type MePayload = { user: { id: string } };

type CreateUserResponse = {
  id: string;
  activationUrl: string;
  activationExpiresAt: string;
  emailDelivery: { status: "SENT" | "DISABLED" | "FAILED"; message: string };
};

const ROLE_OPTIONS: Array<{ value: UserRole; label: string; description: string }> = [
  { value: "CLIENT_VIEWER", label: "Organization Viewer", description: "Read-only access to the organization's workloads and activity." },
  { value: "CLIENT_OPERATOR", label: "Organization Operator", description: "Operate assigned workloads: restart, view logs, act on attention items." },
  { value: "CLIENT_ADMIN", label: "Organization Admin", description: "Everything an Operator can do, plus manage organization members and settings." },
  { value: "ADMIN", label: "Platform Admin", description: "Full platform access: all organizations, nodes, users, and platform settings." }
];

function statusLabel(user: UserRecord): "Active" | "Pending activation" | "Disabled" {
  if (!user.isActive) return user.pending ? "Pending activation" : "Disabled";
  return "Active";
}

function StatusChip({ user }: { user: UserRecord }): React.JSX.Element {
  const status = statusLabel(user);
  if (status === "Active") return <Badge variant="success">Active</Badge>;
  if (status === "Pending activation") return <Badge variant="warning">Pending activation</Badge>;
  return <Badge variant="neutral">Disabled</Badge>;
}

export default function AdminUsersPage(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>("CLIENT_OPERATOR");
  const [clientAccountId, setClientAccountId] = useState("");
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const [emailDelivery, setEmailDelivery] = useState<CreateUserResponse["emailDelivery"] | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<UserRecord | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserRecord | null>(null);

  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [state, setState] = useState(searchParams.get("state") ?? "");
  const [orgFilter, setOrgFilter] = useState(searchParams.get("org") ?? "");

  useEffect(() => {
    setSearch(searchParams.get("search") ?? "");
    setState(searchParams.get("state") ?? "");
    setOrgFilter(searchParams.get("org") ?? "");
  }, [searchParams]);

  const syncUrl = useCallback(
    (patch: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const query = params.toString();
      router.push(query ? `/admin/settings/users?${query}` : "/admin/settings/users", { scroll: false });
    },
    [router, searchParams]
  );

  const userActions = (u: UserRecord): Array<{ label: string; tone?: "default" | "danger"; onSelect: () => void }> => [
    { label: "Open user detail", onSelect: () => router.push(`/admin/settings/users/${u.id}`) },
    ...(u.pending
      ? [{ label: "Resend activation", onSelect: () => resendMutation.mutate(u.id) }]
      : []),
    {
      label: u.isActive ? "Disable user" : "Enable user",
      onSelect: () =>
        u.isActive
          ? setConfirmDisable(u)
          : !u.clientAccountId && u.role !== "ADMIN"
            ? router.push(`/admin/settings/users/${u.id}`)
            : updateMutation.mutate({ id: u.id, isActive: true })
    },
    {
      label: "Delete user",
      tone: "danger" as const,
      onSelect: () => setConfirmDelete(u)
    }
  ];

  const query = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => apiFetch<UsersPayload>("/api/admin/users")
  });

  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<MePayload>("/api/auth/me")
  });
  const currentUserId = meQuery.data?.user.id ?? null;

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<CreateUserResponse>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email,
          displayName,
          role,
          clientAccountId: role !== "ADMIN" ? clientAccountId || null : null
        })
      }),
    onSuccess: (data) => {
      data.emailDelivery.status === "SENT"
        ? toast.success("User created and invitation email sent")
        : toast.error("User created — invitation email was not sent");
      setActivationUrl(data.activationUrl);
      setEmailDelivery(data.emailDelivery);
      setEmail("");
      setDisplayName("");
      setClientAccountId("");
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Create failed")
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) =>
      apiFetch<{ success: boolean }>(`/api/admin/users/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify(input)
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Update failed")
  });

  const resendMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ activationUrl: string; activationExpiresAt: string; emailDelivery: CreateUserResponse["emailDelivery"] }>(`/api/admin/users/${id}/resend-activation`, {
        method: "POST"
      }),
    onSuccess: (data) => {
      data.emailDelivery.status === "SENT"
        ? toast.success("Activation email reissued")
        : toast.error("Activation link regenerated — email was not sent");
      setActivationUrl(data.activationUrl);
      setEmailDelivery(data.emailDelivery);
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Resend failed")
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/admin/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("User deleted");
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Delete failed")
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    createMutation.mutate();
  }

  const closeInvite = (): void => {
    setInviteOpen(false);
    setActivationUrl(null);
    setEmailDelivery(null);
  };

  const allUsers = query.data?.users ?? [];
  const rows = useMemo(() => {
    let out = allUsers;
    if (search) {
      const q = search.toLowerCase();
      out = out.filter((u) => `${u.displayName} ${u.email} ${u.role} ${u.clientAccount?.name ?? ""}`.toLowerCase().includes(q));
    }
    if (state === "active") out = out.filter((u) => u.isActive);
    else if (state === "disabled") out = out.filter((u) => !u.isActive && !u.pending);
    else if (state === "pending") out = out.filter((u) => u.pending);
    if (orgFilter) out = out.filter((u) => u.clientAccountId === orgFilter);
    return out;
  }, [allUsers, search, state, orgFilter]);

  const selectedRoleDescription = ROLE_OPTIONS.find((option) => option.value === role)?.description;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Access"
        title="Users"
        count={allUsers.length}
        description="Invite users; they set their own password via a one-time Noderaft activation link."
        actions={<Button onClick={() => setInviteOpen(true)}>Invite user</Button>}
      />

      <DesktopFilterBar
        search={search}
        onSearchChange={(value) => { setSearch(value); syncUrl({ search: value }); }}
        searchPlaceholder="Search users…"
        dimensions={[
          { id: "state", label: "Status", value: state, options: [{ value: "active", label: "Active" }, { value: "disabled", label: "Disabled" }, { value: "pending", label: "Pending activation" }], onChange: (value) => { setState(value); syncUrl({ state: value }); } },
          { id: "org", label: "Organization", value: orgFilter, options: (query.data?.clients ?? []).map((c) => ({ value: c.id, label: c.name })), onChange: (value) => { setOrgFilter(value); syncUrl({ org: value }); } }
        ]}
        resultCount={rows.length}
        totalCount={allUsers.length}
        onClearAll={() => { setSearch(""); setState(""); setOrgFilter(""); syncUrl({ search: "", state: "", org: "" }); }}
      />
      <div className="md:hidden">
        <Input type="search" value={search} onChange={(event) => { setSearch(event.target.value); syncUrl({ search: event.target.value }); }} placeholder="Search users…" aria-label="Search users" />
      </div>

      <DataTable
        columns={[
          {
            key: "user",
            header: "User",
            sortValue: (u: UserRecord) => u.displayName.toLowerCase(),
            render: (u: UserRecord) => (
              <div>
                <p className="flex items-center gap-1.5 font-medium">
                  {u.displayName}
                  {u.id === currentUserId && (
                    <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-text-subtle">You</span>
                  )}
                </p>
                <p className="font-mono text-xs text-muted">{u.email}</p>
              </div>
            )
          },
          {
            key: "client",
            header: "Organization",
            sortValue: (u: UserRecord) => u.clientAccount?.name ?? "",
            render: (u: UserRecord) => u.clientAccount ? <span className="text-sm text-muted">{u.clientAccount.name}</span> : <span className="text-sm text-text-subtle">All organizations</span>
          },
          {
            key: "role",
            header: "Role",
            sortValue: (u: UserRecord) => u.role,
            render: (u: UserRecord) => <span className="text-sm">{roleLabel(u.role)}</span>
          },
          {
            key: "status",
            header: "Status",
            sortValue: (u: UserRecord) => statusLabel(u),
            render: (u: UserRecord) => <StatusChip user={u} />
          },
          {
            key: "lastSignIn",
            header: "Last sign-in",
            sortValue: (u: UserRecord) => u.lastLoginAt ?? "",
            render: (u: UserRecord) => <span className="text-xs text-muted">{timeAgo(u.lastLoginAt)}</span>,
            hideBelow: "sm"
          },
          {
            key: "actions",
            header: "",
            render: (u: UserRecord) => (
              <div className="flex justify-end">
                <Menu label={`Actions for ${u.displayName}`} items={userActions(u)} />
              </div>
            )
          }
        ]}
        rows={rows}
        loading={query.isLoading}
        error={query.isError ? "Failed to load users." : null}
        emptyTitle="No users yet"
        emptyBody="Invite the first user to get started."
        pageSize={25}
        stateKey="admin-users"
        ariaLabel="Users"
        rowKey={(u: UserRecord) => u.id}
        onRowClick={(u: UserRecord) => router.push(`/admin/settings/users/${u.id}`)}
        mobileCard={(u: UserRecord) =>
          userCard(
            u,
            <Menu label={`Actions for ${u.displayName}`} items={userActions(u)} />
          )
        }
      />

      <Drawer
        open={inviteOpen}
        onClose={closeInvite}
        title="Invite user"
        description="No passwords are set or displayed here — the invited user activates their own account."
        footer={
          activationUrl ? (
            <Button onClick={closeInvite}>Done</Button>
          ) : (
            <Button disabled={createMutation.isPending} form="invite-user-form" type="submit">
              {createMutation.isPending ? "Creating…" : "Create invite"}
            </Button>
          )
        }
      >
        {activationUrl ? (
          <div className="rounded border border-border bg-panelAlt p-3 text-sm">
            <p className="font-medium">Activation link (shown once — copy it now)</p>
            {emailDelivery && <p className={emailDelivery.status === "SENT" ? "mt-1 text-success-foreground" : "mt-1 text-warning-foreground"}>{emailDelivery.status === "SENT" ? "Invitation email sent." : `Email was not sent: ${emailDelivery.message}. Share this link manually.`}</p>}
            <p className="mt-1 break-all text-muted">
              {window.location.origin}
              {activationUrl}
            </p>
            <Button
              className="mt-2"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(`${window.location.origin}${activationUrl}`);
                toast.success("Activation link copied");
              }}
            >
              Copy link
            </Button>
          </div>
        ) : (
          <form id="invite-user-form" className="space-y-4" onSubmit={submit}>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted">Email</label>
              <Input placeholder="name@example.com" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted">Display name</label>
              <Input placeholder="Display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted">Role</label>
              <Select value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
                {ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              {selectedRoleDescription && <p className="text-xs text-text-subtle">{selectedRoleDescription}</p>}
            </div>
            {role !== "ADMIN" && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted">Organization</label>
                <Select value={clientAccountId} onChange={(event) => setClientAccountId(event.target.value)} required>
                  <option value="">Select organization</option>
                  {(query.data?.clients ?? []).map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </form>
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmDisable !== null}
        onClose={() => setConfirmDisable(null)}
        onConfirm={() => {
          if (confirmDisable) updateMutation.mutate({ id: confirmDisable.id, isActive: false });
          setConfirmDisable(null);
        }}
        title={`Disable ${confirmDisable?.displayName ?? "this user"}?`}
        impact="They will lose access on their next request. This is reversible."
        confirmLabel="Disable user"
        danger
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (confirmDelete) await deleteMutation.mutateAsync(confirmDelete.id);
          setConfirmDelete(null);
        }}
        title={`Delete ${confirmDelete?.displayName ?? "this user"}?`}
        impact={`${confirmDelete?.email ?? "This user"} will be permanently removed and can no longer authenticate. Their past actions remain in Activity/Audit history. This cannot be undone.`}
        confirmLabel="Delete user"
        danger
      />
    </div>
  );
}
