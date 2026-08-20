"use client";

import { FormEvent, Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { isApiError } from "@/lib/fetcher";
import { NoderaftLogo } from "@/components/brand/noderaft-logo";

type ActivateResponse = {
  user: { id: string; email: string; role: "ADMIN" | "CLIENT" };
  redirectPath: string;
};

function ActivateForm(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  if (!token) {
    return (
      <Card className="panel">
        <CardHeader>
          <CardTitle>Invalid activation link</CardTitle>
          <CardDescription>This link is missing its activation token.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted">
            Ask the administrator who invited you for a fresh invitation link. Invitation links are single-use and
            expire.
          </p>
        </CardContent>
      </Card>
    );
  }

  function validate(): string | null {
    if (password.length < 12) return "Password must be at least 12 characters.";
    if (password.length > 128) return "Password must be at most 128 characters.";
    if (!/[a-zA-Z]/.test(password)) return "Password must contain at least one letter.";
    if (!/\d/.test(password)) return "Password must contain at least one digit.";
    if (password !== confirm) return "Passwords do not match.";
    return null;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const problem = validate();
    setValidationError(problem);
    if (problem) return;

    setLoading(true);
    try {
      const response = await fetch("/api/auth/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password })
      });
      const payload = (await response.json()) as
        | { ok: true; data: ActivateResponse }
        | { ok: false; error: { code: string; message: string } };

      if (!payload.ok) {
        throw new Error(payload.error.message);
      }

      toast.success(`Account activated — welcome, ${payload.data.user.email}`);
      router.push(payload.data.redirectPath);
      router.refresh();
    } catch (error) {
      setValidationError(
        isApiError(error) || error instanceof Error
          ? error.message
          : "Activation failed"
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="panel">
      <CardHeader>
        <CardTitle>Activate your account</CardTitle>
        <CardDescription>Set your own password to finish signing up. You will be signed in automatically.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <label className="text-sm text-muted" htmlFor="password">
              Password
            </label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <p className="text-xs text-muted">At least 12 characters, with at least one letter and one digit.</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm text-muted" htmlFor="confirm">
              Confirm password
            </label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
            />
          </div>
          {validationError && <p className="text-sm text-critical-foreground">{validationError}</p>}
          <Button className="w-full" disabled={loading} type="submit">
            {loading ? "Activating…" : "Activate account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function ActivatePage(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-6 py-16">
      <div className="grid w-full gap-8 lg:grid-cols-[1.2fr_1fr]">
        <section className="panel hidden p-12 lg:block">
          <NoderaftLogo className="h-10" priority />
          <h1 className="mt-4 text-4xl font-semibold leading-tight">
            One click from your administrator, and you&apos;re in.
          </h1>
          <p className="mt-6 max-w-xl text-muted">
            Activate your account by choosing a strong password. Your administrator controls which workloads and
            containers you can see and operate.
          </p>
        </section>

        {/* useSearchParams requires a Suspense boundary during static rendering */}
        <Suspense fallback={<div className="h-40 animate-pulse rounded-lg bg-panelAlt" />}>
          <ActivateForm />
        </Suspense>
      </div>
    </main>
  );
}
