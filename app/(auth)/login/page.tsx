"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NoderaftLogo } from "@/components/brand/noderaft-logo";
import { DocumentTitle } from "@/components/brand/document-title";

type LoginResponse = {
  user: {
    id: string;
    email: string;
    role: "ADMIN" | "CLIENT";
  };
  redirectPath: string;
};

export default function LoginPage(): React.JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    const expired = window.sessionStorage.getItem("noderaft:session-expired") === "1";
    if (expired) {
      window.sessionStorage.removeItem("noderaft:session-expired");
      setSessionExpired(true);
    }
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email, password })
      });

      const payload = (await response.json()) as
        | { ok: true; data: LoginResponse }
        | { ok: false; error: { message: string } };

      if (!payload.ok) {
        throw new Error(payload.error.message);
      }

      toast.success("Logged in successfully");
      router.push(payload.data.redirectPath);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-6 py-16">
      <DocumentTitle title="Sign in" />
      <div className="grid w-full gap-8 lg:grid-cols-[1.2fr_1fr]">
        <section className="panel hidden p-12 lg:block">
          <NoderaftLogo className="h-10" priority />
          <p className="eyebrow mt-12">Self-hosted control panel · Rootless Docker</p>
          <h1 className="mt-4 max-w-lg text-5xl font-semibold leading-[1.05] tracking-[-0.04em]">
            Your fleet,<br />on one deck.
          </h1>
          <p className="mt-6 max-w-xl text-text-muted">
            A single calm surface for every node, workload and container — with the state that needs you kept at the top.
          </p>
        </section>

        <Card className="panel">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              Use your Noderaft account credentials, or your Linux system username/password.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sessionExpired && (
              <div className="mb-4 rounded-control border border-warning/30 bg-warning/5 p-3 text-sm text-warning-foreground" role="status">
                Your session expired. Sign in again to continue.
              </div>
            )}
            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="space-y-2">
                <label className="text-sm text-muted" htmlFor="email">
                  Email or Linux username
                </label>
                <Input
                  id="email"
                  type="text"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted" htmlFor="password">
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>

              <Button className="w-full" disabled={loading} type="submit">
                {loading ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
