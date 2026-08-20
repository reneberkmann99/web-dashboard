"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";

type MePayload = {
  user: { id: string; email: string; displayName: string; role: string; clientAccountName: string | null };
};

export default function AccountPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const query = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<MePayload>("/api/auth/me")
  });

  const nameMutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ displayName: string }>("/api/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ displayName: name })
      }),
    onSuccess: () => {
      toast.success("Display name updated");
      queryClient.invalidateQueries({ queryKey: ["me"] });
      window.location.reload();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Update failed")
  });

  const passwordMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean }>("/api/auth/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword })
      }),
    onSuccess: () => {
      toast.success("Password changed");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Password change failed")
  });

  const sessionsMutation = useMutation({
    mutationFn: () => apiFetch<{ invalidatedSessions: number }>("/api/auth/me/sessions", { method: "POST" }),
    onSuccess: (data) => toast.success(`Logged out ${data.invalidatedSessions} other session(s)`),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed")
  });

  function submitName(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (displayName.trim().length >= 2) nameMutation.mutate(displayName.trim());
  }

  function submitPassword(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match");
      return;
    }
    passwordMutation.mutate();
  }

  const user = query.data?.user;

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Account" title="Account settings" description="Manage your profile, password, and active sessions." />

      <Card className="panel max-w-2xl">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your email address is fixed by your administrator.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Email</label>
            <Input value={user?.email ?? ""} disabled />
          </div>
          <form className="flex items-end gap-2" onSubmit={submitName}>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted">Display name</label>
              <Input
                value={displayName || user?.displayName || ""}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={nameMutation.isPending || (displayName.trim() === (user?.displayName ?? ""))}>
              {nameMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="panel max-w-2xl">
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>Re-verify your current password to set a new one.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={submitPassword}>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Current password</label>
              <Input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">New password</label>
              <Input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={12} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Confirm new password</label>
              <Input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
            </div>
            <Button type="submit" disabled={passwordMutation.isPending}>
              {passwordMutation.isPending ? "Changing…" : "Change password"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="panel max-w-2xl">
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>Log out of every other device while keeping this session active.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="secondary" onClick={() => sessionsMutation.mutate()} disabled={sessionsMutation.isPending}>
            {sessionsMutation.isPending ? "Working…" : "Log out other sessions"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
