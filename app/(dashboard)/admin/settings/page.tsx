"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Mail, Send, Server, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { BRAND } from "@/lib/brand";
import { apiFetch } from "@/lib/fetcher";
import { timeAgo } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { TabBar } from "@/components/ui/tab-bar";

const TABS = ["General", "Email", "Security", "Agents"] as const;
type Tab = (typeof TABS)[number];
type SmtpEncryption = "STARTTLS" | "TLS" | "NONE";
type EmailSettings = {
  enabled: boolean;
  host: string | null;
  port: number | null;
  encryption: SmtpEncryption;
  username: string | null;
  passwordConfigured: boolean;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  encryptionReady: boolean;
  lastTest: { status: "SUCCEEDED" | "FAILED"; at: string; summary: string; detail: string | null } | null;
};
type EmailForm = {
  enabled: boolean;
  host: string;
  port: string;
  encryption: SmtpEncryption;
  username: string;
  password: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
};
type TestResult = { status: "SENT" | "DISABLED" | "FAILED"; message: string; detail?: string };

function formFromSettings(settings: EmailSettings): EmailForm {
  return {
    enabled: settings.enabled,
    host: settings.host ?? "",
    port: settings.port?.toString() ?? "587",
    encryption: settings.encryption,
    username: settings.username ?? "",
    password: "",
    fromName: settings.fromName ?? "Noderaft",
    fromEmail: settings.fromEmail ?? "",
    replyTo: settings.replyTo ?? ""
  };
}

function TestStatus({ value }: { value: EmailSettings["lastTest"] }): React.JSX.Element {
  if (!value) return <p className="text-sm text-text-muted">No SMTP test has been sent yet.</p>;
  const success = value.status === "SUCCEEDED";
  return (
    <div className={success ? "rounded-control border border-success/30 bg-success/5 p-3" : "rounded-control border border-critical/30 bg-critical/5 p-3"}>
      <div className="flex items-center gap-2 text-sm">
        {success ? <CheckCircle2 className="h-4 w-4 text-success-foreground" /> : <Mail className="h-4 w-4 text-critical-foreground" />}
        <span className={success ? "font-medium text-success-foreground" : "font-medium text-critical-foreground"}>{value.summary}</span>
        <span className="text-text-muted">· {timeAgo(value.at)}</span>
      </div>
      {value.detail && <div className="mt-3"><Disclosure label="Protocol details"><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-control bg-black/15 p-3 font-mono text-xs text-text-muted">{value.detail}</pre></Disclosure></div>}
    </div>
  );
}

export default function PlatformSettingsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("General");
  const [form, setForm] = useState<EmailForm>(formFromSettings({
    enabled: false, host: null, port: null, encryption: "STARTTLS", username: null, passwordConfigured: false,
    fromName: null, fromEmail: null, replyTo: null, encryptionReady: true, lastTest: null
  }));
  const [replaceCredential, setReplaceCredential] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState("");

  const emailSettings = useQuery({
    queryKey: ["platform-email-settings"],
    queryFn: () => apiFetch<EmailSettings>("/api/admin/platform-settings/email")
  });
  const needsPasswordInput = !emailSettings.data?.passwordConfigured || replaceCredential;

  useEffect(() => {
    if (emailSettings.data) {
      setForm(formFromSettings(emailSettings.data));
      setReplaceCredential(false);
    }
  }, [emailSettings.data]);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["platform-email-settings"] });
  };
  const save = useMutation({
    mutationFn: () => apiFetch<EmailSettings>("/api/admin/platform-settings/email", {
      method: "PATCH",
      body: JSON.stringify({
        ...form,
        host: form.host.trim() || null,
        port: form.port.trim() ? Number(form.port) : null,
        username: form.username.trim() || null,
        ...(needsPasswordInput && form.password ? { password: form.password } : {}),
        fromName: form.fromName.trim() || null,
        fromEmail: form.fromEmail.trim() || null,
        replyTo: form.replyTo.trim() || null
      })
    }),
    onSuccess: async () => {
      toast.success("Email settings saved");
      await refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save email settings")
  });
  const sendTest = useMutation({
    mutationFn: () => apiFetch<TestResult>("/api/admin/platform-settings/email/test", {
      method: "POST",
      body: JSON.stringify({ to: testTo })
    }),
    onSuccess: async (result) => {
      result.status === "SENT" ? toast.success("Test email sent") : toast.error(result.message);
      if (result.status !== "SENT" && result.detail) toast.message("Open protocol details below for the safe diagnostic.");
      setTestOpen(false);
      await refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not send test email")
  });

  const current = emailSettings.data;
  const set = <K extends keyof EmailForm>(key: K, value: EmailForm[K]): void => setForm((previous) => ({ ...previous, [key]: value }));

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Platform" title="Platform Settings" description="Platform-wide services and server-managed configuration." />
      <TabBar tabs={TABS} active={tab} onChange={setTab} idPrefix="platform-settings" />

      {tab === "General" && <section id="platform-settings-panel-General" role="tabpanel" aria-labelledby="platform-settings-tab-General" className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle>Platform identity</CardTitle><CardDescription>The public and platform endpoints currently used by Noderaft.</CardDescription></CardHeader><CardContent className="space-y-3 text-sm"><p><span className="text-text-muted">Product</span><br />{BRAND.productName}</p><p><span className="text-text-muted">Platform</span><br /><a href={BRAND.platformUrl} className="text-accent hover:underline">{BRAND.platformUrl}</a></p><p><span className="text-text-muted">Public site</span><br /><a href={BRAND.publicSiteUrl} className="text-accent hover:underline">{BRAND.publicSiteUrl}</a></p></CardContent></Card>
        <Card><CardHeader><CardTitle>Scope</CardTitle><CardDescription>Only settings backed by the running platform are exposed here.</CardDescription></CardHeader><CardContent className="text-sm text-text-muted"><p>Email delivery is configured in the Email tab. Account management is available under All Users; agent registration and health are managed from Nodes.</p></CardContent></Card>
      </section>}

      {tab === "Email" && <section id="platform-settings-panel-Email" role="tabpanel" aria-labelledby="platform-settings-tab-Email" className="space-y-4">
        {emailSettings.isLoading ? <div className="h-72 animate-pulse rounded-panel bg-surface-deck" /> : !current ? <p className="text-sm text-critical-foreground">Email settings could not be loaded.</p> : <>
          <Card><CardHeader><CardTitle>Email delivery</CardTitle><CardDescription>One shared SMTP transport for invitations, account/security emails, and future alerting.</CardDescription></CardHeader><CardContent className="space-y-5">
            {!current.encryptionReady && <div className="rounded-control border border-critical/30 bg-critical/5 p-3 text-sm text-critical-foreground">SMTP credential encryption is not configured on this platform. Add <code>SMTP_CREDENTIALS_KEY</code> before saving a password.</div>}
            <label className="flex items-center gap-3 text-sm font-medium"><input type="checkbox" checked={form.enabled} onChange={(event) => set("enabled", event.target.checked)} className="h-4 w-4 accent-accent" /> Enable email delivery</label>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm">SMTP host<Input className="mt-1" value={form.host} onChange={(event) => set("host", event.target.value)} placeholder="smtp.example.com" autoComplete="off" /></label>
              <label className="text-sm">Port<Input className="mt-1" type="number" min="1" max="65535" value={form.port} onChange={(event) => set("port", event.target.value)} placeholder="587" /></label>
              <label className="text-sm">Encryption<Select className="mt-1" value={form.encryption} onChange={(event) => set("encryption", event.target.value as SmtpEncryption)}><option value="STARTTLS">STARTTLS</option><option value="TLS">TLS</option><option value="NONE">None</option></Select></label>
              <label className="text-sm">Username<Input className="mt-1" value={form.username} onChange={(event) => set("username", event.target.value)} autoComplete="username" /></label>
            </div>
            <div className="rounded-control border border-border bg-panelAlt/40 p-4">
              <p className="text-sm font-medium">SMTP password</p>
              {current.passwordConfigured && !replaceCredential ? <div className="mt-2 flex flex-wrap items-center gap-3"><span className="inline-flex items-center gap-1.5 text-sm text-success-foreground"><KeyRound className="h-4 w-4" /> Password configured</span><Button size="sm" variant="secondary" onClick={() => setReplaceCredential(true)}>Replace credential</Button></div> : <div className="mt-2 space-y-2"><Input type="password" value={form.password} onChange={(event) => set("password", event.target.value)} autoComplete="new-password" placeholder={current.passwordConfigured ? "New SMTP password" : "SMTP password"} /><p className="text-xs text-text-muted">The password is AES-256-GCM encrypted at rest and is never displayed after save.</p>{current.passwordConfigured && <Button size="sm" variant="ghost" onClick={() => { setReplaceCredential(false); set("password", ""); }}>Keep current credential</Button>}</div>}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm">From name<Input className="mt-1" value={form.fromName} onChange={(event) => set("fromName", event.target.value)} placeholder="Noderaft" /></label>
              <label className="text-sm">From email<Input className="mt-1" type="email" value={form.fromEmail} onChange={(event) => set("fromEmail", event.target.value)} placeholder="platform@noderaft.ee" /></label>
              <label className="text-sm md:col-span-2">Reply-to <span className="text-text-muted">(optional)</span><Input className="mt-1" type="email" value={form.replyTo} onChange={(event) => set("replyTo", event.target.value)} placeholder="support@noderaft.ee" /></label>
            </div>
            <div className="flex flex-wrap gap-2"><Button onClick={() => save.mutate()} disabled={save.isPending || (form.enabled && needsPasswordInput && !form.password) || (!current.encryptionReady && needsPasswordInput && Boolean(form.password))}>{save.isPending ? "Saving…" : "Save email settings"}</Button><Button variant="secondary" disabled={!current.enabled} onClick={() => setTestOpen(true)}><Send className="mr-2 h-4 w-4" /> Send test email</Button></div>
            {!current.enabled && <p className="text-xs text-text-muted">Enable and save email delivery before sending a test. Invitations will continue to provide a copyable activation link while delivery is disabled.</p>}
          </CardContent></Card>
          <Card><CardHeader><CardTitle>Last test</CardTitle><CardDescription>Safe SMTP result details are retained without credentials.</CardDescription></CardHeader><CardContent><TestStatus value={current.lastTest} /></CardContent></Card>
        </>}
      </section>}

      {tab === "Security" && <section id="platform-settings-panel-Security" role="tabpanel" aria-labelledby="platform-settings-tab-Security" className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle>Credential protection</CardTitle><CardDescription>SMTP passwords are write-only platform secrets.</CardDescription></CardHeader><CardContent className="flex items-center gap-2 text-sm"><ShieldCheck className={current?.encryptionReady ? "h-5 w-5 text-success-foreground" : "h-5 w-5 text-critical-foreground"} /><span>{current?.encryptionReady ? "SMTP credential encryption is ready" : "SMTP credential encryption requires server configuration"}</span></CardContent></Card>
        <Card><CardHeader><CardTitle>Access</CardTitle><CardDescription>Platform settings are restricted to Platform Admins.</CardDescription></CardHeader><CardContent className="text-sm text-text-muted">Credentials are never included in API reads, Activity records, or client-visible diagnostics.</CardContent></Card>
      </section>}

      {tab === "Agents" && <section id="platform-settings-panel-Agents" role="tabpanel" aria-labelledby="platform-settings-tab-Agents"><Card><CardHeader><CardTitle>Agent management</CardTitle><CardDescription>Noderaft Agents are registered and configured per node.</CardDescription></CardHeader><CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm text-text-muted"><span>Use Nodes to enroll agents, manage their secure transport, and review health.</span><Button variant="secondary" onClick={() => { window.location.assign("/admin/nodes"); }}><Server className="mr-2 h-4 w-4" /> Open Nodes</Button></CardContent></Card></section>}

      <Modal open={testOpen} onClose={() => setTestOpen(false)} title="Send test email" description="Noderaft will connect, authenticate, and send a real SMTP test message." footer={<><Button variant="secondary" onClick={() => setTestOpen(false)}>Cancel</Button><Button onClick={() => sendTest.mutate()} disabled={sendTest.isPending || !testTo.trim()}>{sendTest.isPending ? "Sending…" : "Send test email"}</Button></>}>
        <label className="block text-sm">Destination email<Input className="mt-1" type="email" autoFocus value={testTo} onChange={(event) => setTestTo(event.target.value)} placeholder="you@example.com" /></label>
      </Modal>
    </div>
  );
}
