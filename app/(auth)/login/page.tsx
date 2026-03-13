"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

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
  const [email, setEmail] = useState("admin@hostpanel.local");
  const [password, setPassword] = useState("ChangeMe123!");
  const [loading, setLoading] = useState(false);

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
      router.push(payload.data.redirectPath as "/admin" | "/client");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-6 py-16">
      <div className="grid w-full gap-8 lg:grid-cols-[1.2fr_1fr]">
        <section className="panel hidden p-12 lg:block">
          <p className="text-sm uppercase tracking-[0.25em] text-accent">HostPanel</p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight">
            Control client infrastructure from one hardened dashboard.
          </h1>
          <p className="mt-6 max-w-xl text-muted">
            Modern hosting panel MVP with role-based access, node health visibility, rootless Docker support,
            and server-to-server control through secure node agents.
          </p>
        </section>

        <Card className="panel">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Use your HostPanel account credentials.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="space-y-2">
                <label className="text-sm text-muted" htmlFor="email">
                  Email
                </label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
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
