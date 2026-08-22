"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import type { UserRecord, UserRole, NameRef } from "@/types/domain";
import { PageHeader } from "@/components/ui/page-header";
import { Menu } from "@/components/ui/menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { userCard } from "@/components/mobile/mobile-resource-cards";

type UsersPayload = {
  users: UserRecord[];
  clients: NameRef[];
};

type CreateUserResponse = {
  id: string;
  activationUrl: string;
  activationExpiresAt: string;
};

const ROLE_OPTIONS: Array<{ value: UserRole; label: string }> = [
  { value: "CLIENT_VIEWER", label: "Client Viewer (read-only)" },
  { value: "CLIENT_OPERATOR", label: "Client Operator (operate assigned workloads)" },
  { value: "CLIENT_ADMIN", label: "Client Admin (manage own client users)" },
  { value: "ADMIN", label: "Platform Admin" }
];

export default function AdminUsersPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>("CLIENT_OPERATOR");
  const [clientAccountId, setClientAccountId] = useState("");
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<UserRecord | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserRecord | null>(null);

  const userActions = (u: UserRecord): Array<{ label: string; tone?: "default" | "danger"; onSelect: () => void }> => [
    ...(u.pending
      ? [{ label: "Resend activation", onSelect: () => resendMutation.mutate(u.id) }]
      : []),
    {
      label: u.isActive ? "Disable user" : "Enable user",
      onSelect: () =>
        u.isActive
          ? setConfirmDisable(u)
          : updateMutation.mutate({ id: u.id, role: u.role, isActive: true, clientAccountId: u.clientAccountId })
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
      toast.success("User created — pending activation");
      setActivationUrl(data.activationUrl);
      setEmail("");
      setDisplayName("");
      setClientAccountId("");
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Create failed")
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; role: UserRole; isActive: boolean; clientAccountId: string | null }) =>
      apiFetch<{ success: boolean }>(`/api/admin/users/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify(input)
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Update failed")
  });

  const resendMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ activationUrl: string; activationExpiresAt: string }>(`/api/admin/users/${id}/resend-activation`, {
        method: "POST"
      }),
    onSuccess: (data) => {
      toast.success("Activation link regenerated");
      setActivationUrl(data.activationUrl);
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

  function statusLabel(user: UserRecord): string {
    if (!user.isActive) {
      return user.pending ? "Pending activation" : "Disabled";
    }
    return "Active";
  }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Access" title="User management" description="Invite users; they set their own password via a one-time Noderaft activation link." />

      <Card className="panel">
        <CardHeader>
          <CardTitle>Invite user</CardTitle>
          <CardDescription>
            No passwords are set or displayed here — the invited user activates their own account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form className="grid gap-3 md:grid-cols-4" onSubmit={submit}>
            <Input placeholder="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            <Input placeholder="Display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
            <Select value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            {role !== "ADMIN" && (
              <Select value={clientAccountId} onChange={(event) => setClientAccountId(event.target.value)} required>
                <option value="">Select client</option>
                {(query.data?.clients ?? []).map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </Select>
            )}
            <div className="md:col-span-4">
              <Button disabled={createMutation.isPending} type="submit">
                {createMutation.isPending ? "Creating..." : "Create invite"}
              </Button>
            </div>
          </form>

          {activationUrl && (
            <div className="rounded border border-border bg-panelAlt p-3 text-sm">
              <p className="font-medium">Activation link (shown once — copy it now)</p>
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
          )}
        </CardContent>
      </Card>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>Disable to revoke access reversibly; delete to permanently remove the account.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={[
              {
                key: "user",
                header: "User",
                sortValue: (u: UserRecord) => u.displayName.toLowerCase(),
                render: (u: UserRecord) => (
                  <div>
                    <p className="font-medium">{u.displayName}</p>
                    <p className="font-mono text-xs text-muted">{u.email}</p>
                  </div>
                )
              },
              {
                key: "client",
                header: "Client",
                sortValue: (u: UserRecord) => u.clientAccount?.name ?? "",
                render: (u: UserRecord) =>
                  u.role === "ADMIN" ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <Select
                      value={u.clientAccountId ?? ""}
                      onChange={(event) =>
                        updateMutation.mutate({
                          id: u.id,
                          role: u.role,
                          isActive: u.isActive,
                          clientAccountId: event.target.value || null
                        })
                      }
                    >
                      <option value="">Unassigned</option>
                      {(query.data?.clients ?? []).map((client) => (
                        <option key={client.id} value={client.id}>
                          {client.name}
                        </option>
                      ))}
                    </Select>
                  )
              },
              {
                key: "role",
                header: "Role",
                sortValue: (u: UserRecord) => u.role,
                render: (u: UserRecord) => (
                  <Select
                    value={u.role}
                    onChange={(event) =>
                      updateMutation.mutate({
                        id: u.id,
                        role: event.target.value as UserRole,
                        isActive: u.isActive,
                        clientAccountId: u.clientAccountId
                      })
                    }
                  >
                    {ROLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                )
              },
              {
                key: "status",
                header: "Status",
                sortValue: (u: UserRecord) => statusLabel(u),
                render: (u: UserRecord) =>
                  u.isActive ? (
                    <span className="text-success-foreground">Active</span>
                  ) : u.pending ? (
                    <span className="text-warning-foreground">Pending activation</span>
                  ) : (
                    <span className="text-critical-foreground">Disabled</span>
                  )
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
            rows={query.data?.users ?? []}
            searchableText={(u: UserRecord) => `${u.displayName} ${u.email} ${u.role} ${u.clientAccount?.name ?? ""}`}
            searchPlaceholder="Search users…"
            loading={query.isLoading}
            error={query.isError ? "Failed to load users." : null}
            emptyTitle="No users yet"
            emptyBody="Invite the first user to get started."
            pageSize={25}
            stateKey="admin-users"
            ariaLabel="Users"
            rowKey={(u: UserRecord) => u.id}
            mobileCard={(u: UserRecord) =>
              userCard(
                u,
                <Menu label={`Actions for ${u.displayName}`} items={userActions(u)} />
              )
            }
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmDisable !== null}
        onClose={() => setConfirmDisable(null)}
        onConfirm={() => {
          if (confirmDisable) updateMutation.mutate({ id: confirmDisable.id, role: confirmDisable.role, isActive: false, clientAccountId: confirmDisable.clientAccountId });
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
