"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";

const PASSWORD_MIN_LENGTH = 12;

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
            <div className="flex h-control items-center justify-between rounded-control border border-border bg-surface-raised px-3 text-sm text-text">
              <span className="truncate">{user?.email ?? "—"}</span>
              <button
                type="button"
                onClick={() => {
                  if (!user?.email) return;
                  void navigator.clipboard.writeText(user.email);
                  toast.success("Email copied");
                }}
                aria-label="Copy email"
                className="ml-2 shrink-0 rounded-control p-1 text-text-subtle hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Copy size={14} />
              </button>
            </div>
          </div>
          <form className="space-y-3" onSubmit={submitName}>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Display name</label>
              <Input
                value={displayName || user?.displayName || ""}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={nameMutation.isPending || (displayName.trim() === (user?.displayName ?? ""))}>
                {nameMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
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
              <Input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={PASSWORD_MIN_LENGTH} />
              <p className="mt-1 text-xs text-text-subtle">At least {PASSWORD_MIN_LENGTH} characters.</p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">Confirm new password</label>
              <Input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={passwordMutation.isPending}>
                {passwordMutation.isPending ? "Changing…" : "Change password"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="panel max-w-2xl">
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>Log out of every other device while keeping this session active.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => sessionsMutation.mutate()} disabled={sessionsMutation.isPending}>
              {sessionsMutation.isPending ? "Working…" : "Log out other sessions"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
