"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
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
import { roleLabel } from "@/types/domain";
import { timeAgo } from "@/lib/format";

type UsersPayload = {
  users: UserRecord[];
  clients: NameRef[];
};

type CreateUserResponse = {
  id: string;
  activationUrl: string;
  activationExpiresAt: string;
  emailDelivery: { status: "SENT" | "DISABLED" | "FAILED"; message: string };
};

const ROLE_OPTIONS: Array<{ value: UserRole; label: string }> = [
  { value: "CLIENT_VIEWER", label: "Organization Viewer (read-only)" },
  { value: "CLIENT_OPERATOR", label: "Organization Operator (operate assigned workloads)" },
  { value: "CLIENT_ADMIN", label: "Organization Admin (manage organization members)" },
  { value: "ADMIN", label: "Platform Admin" }
];

export default function AdminUsersPage(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>("CLIENT_OPERATOR");
  const [clientAccountId, setClientAccountId] = useState("");
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const [emailDelivery, setEmailDelivery] = useState<CreateUserResponse["emailDelivery"] | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<UserRecord | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserRecord | null>(null);

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

  function statusLabel(user: UserRecord): string {
    if (!user.isActive) {
      return user.pending ? "Pending activation" : "Disabled";
    }
    return "Active";
  }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Access" title="All Users" description="Invite users; they set their own password via a one-time Noderaft activation link." />

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
                <option value="">Select organization</option>
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
          )}
        </CardContent>
      </Card>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>Select a user to manage identity, organization access, security, and lifecycle.</CardDescription>
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
                header: "Organization",
                sortValue: (u: UserRecord) => u.clientAccount?.name ?? "",
                render: (u: UserRecord) => <span className="text-sm text-muted">{u.clientAccount?.name ?? "—"}</span>
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
                key: "lastSignIn",
                header: "Last sign-in",
                sortValue: (u: UserRecord) => u.lastLoginAt ?? "",
                render: (u: UserRecord) => <span className="text-xs text-muted">{timeAgo(u.lastLoginAt)}</span>,
                hideBelow: "sm"
              },
              {
                key: "actions",
                header: "Actions",
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
            onRowClick={(u: UserRecord) => router.push(`/admin/settings/users/${u.id}`)}
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
