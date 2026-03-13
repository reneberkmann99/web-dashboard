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

type UsersPayload = {
  users: UserRecord[];
  clients: NameRef[];
};

export default function AdminUsersPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("ClientPass123!");
  const [role, setRole] = useState<UserRole>("CLIENT");
  const [clientAccountId, setClientAccountId] = useState("");

  const query = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => apiFetch<UsersPayload>("/api/admin/users")
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email,
          displayName,
          password,
          role,
          clientAccountId: role === "CLIENT" ? clientAccountId || null : null
        })
      }),
    onSuccess: () => {
      toast.success("User created");
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
      <div>
        <h1 className="text-3xl font-semibold">User management</h1>
        <p className="text-muted">Assign roles and map users to client accounts.</p>
      </div>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Create user</CardTitle>
          <CardDescription>For MVP, passwords can be admin-managed.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 md:grid-cols-5" onSubmit={submit}>
            <Input placeholder="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            <Input placeholder="display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
            <Input placeholder="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            <Select value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
              <option value="CLIENT">CLIENT</option>
              <option value="ADMIN">ADMIN</option>
            </Select>
            <Select
              disabled={role !== "CLIENT"}
              value={clientAccountId}
              onChange={(event) => setClientAccountId(event.target.value)}
            >
              <option value="">No client</option>
              {(query.data?.clients ?? []).map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
            <div className="md:col-span-5">
              <Button disabled={createMutation.isPending} type="submit">
                {createMutation.isPending ? "Creating..." : "Create user"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="panel">
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>Role-based access control assignments.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {query.isLoading ? (
            <div className="space-y-3">
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
              <div className="h-10 animate-pulse rounded bg-panelAlt" />
            </div>
          ) : query.isError ? (
            <p className="text-sm text-red-400">Failed to load users.</p>
          ) : !(query.data?.users ?? []).length ? (
            <p className="text-sm text-muted">No users yet. Create one above.</p>
          ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="pb-2">User</th>
                <th className="pb-2">Role</th>
                <th className="pb-2">Client</th>
                <th className="pb-2">State</th>
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
                  <td className="py-3">{user.role}</td>
                  <td className="py-3">{user.clientAccount?.name ?? "-"}</td>
                  <td className="py-3">{user.isActive ? "active" : "inactive"}</td>
                  <td className="py-3">
                    <div className="flex gap-2">
                      <Button
                        disabled={updateMutation.isPending}
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          updateMutation.mutate({
                            id: user.id,
                            role: user.role === "ADMIN" ? "CLIENT" : "ADMIN",
                            isActive: user.isActive,
                            clientAccountId: user.clientAccountId
                          })
                        }
                      >
                        Toggle role
                      </Button>
                      <Button
                        disabled={updateMutation.isPending}
                        size="sm"
                        variant={user.isActive ? "danger" : "secondary"}
                        onClick={() =>
                          updateMutation.mutate({
                            id: user.id,
                            role: user.role,
                            isActive: !user.isActive,
                            clientAccountId: user.clientAccountId
                          })
                        }
                      >
                        {user.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
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
