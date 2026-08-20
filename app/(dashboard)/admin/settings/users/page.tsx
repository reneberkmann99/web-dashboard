"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { UserRecord, UserRole, NameRef } from "@/types/domain";
import { PageHeader } from "@/components/ui/page-header";

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] })
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    createMutation.mutate();
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
          <CardDescription>Role changes take effect on the user&apos;s next request.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {query.isLoading ? (
            <div className="space-y-3">
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
            </div>
          ) : query.isError ? (
            <p className="text-sm text-critical-foreground">Failed to load users.</p>
          ) : !(query.data?.users ?? []).length ? (
            <p className="text-sm text-muted">No users yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="pb-2">User</th>
                  <th className="pb-2">Client</th>
                  <th className="pb-2">Role</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(query.data?.users ?? []).map((user) => (
                  <tr className="border-t border-border" key={user.id}>
                    <td className="py-3">
                      <p>{user.displayName}</p>
                      <p className="text-xs text-muted">{user.email}</p>
                    </td>
                    <td className="py-3">{user.clientAccount?.name ?? "—"}</td>
                    <td className="py-3">
                      <Select
                        value={user.role}
                        onChange={(event) =>
                          updateMutation.mutate({
                            id: user.id,
                            role: event.target.value as UserRole,
                            isActive: user.isActive,
                            clientAccountId: user.clientAccountId
                          })
                        }
                      >
                        {ROLE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="py-3">
                      {user.isActive ? (
                        <span className="text-success-foreground">Active</span>
                      ) : (
                        <span className="text-warning-foreground">Pending</span>
                      )}
                    </td>
                    <td className="py-3">
                      <Button
                        disabled={updateMutation.isPending}
                        size="sm"
                        variant={user.isActive ? "danger" : "secondary"}
                        onClick={() => updateMutation.mutate({ id: user.id, role: user.role, isActive: !user.isActive, clientAccountId: user.clientAccountId })}
                      >
                        {user.isActive ? "Disable" : "Enable"}
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
