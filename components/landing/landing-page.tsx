import Image from "next/image";
import {
  Activity,
  ArrowRight,
  Boxes,
  Check,
  ClipboardCheck,
  Container,
  ExternalLink,
  FileClock,
  Layers3,
  LockKeyhole,
  Menu,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  UsersRound
} from "lucide-react";
import { BRAND } from "@/lib/brand";

const platformLink = BRAND.platformUrl;

const workflow = [
  {
    icon: Server,
    title: "Connect each node",
    copy: "Run Noderaft Agent beside the Docker runtime. Rootless Docker is supported when the agent runs with access to the owning user's socket."
  },
  {
    icon: Layers3,
    title: "Model real workloads",
    copy: "Group containers into workloads, adopt existing Compose projects, or manage validated Compose revisions through a release lifecycle."
  },
  {
    icon: Activity,
    title: "Operate from one view",
    copy: "Keep attention, active operations, runtime health and recent failures in context instead of jumping between individual hosts."
  }
] as const;

const capabilities = [
  {
    icon: ClipboardCheck,
    title: "Attention before inventory",
    copy: "Active conditions are grouped by root cause, with acknowledgement, silence and maintenance controls for operators."
  },
  {
    icon: RefreshCw,
    title: "Managed Compose lifecycle",
    copy: "Validate revisions, review diffs and plans, follow deployment progress, inspect releases and roll back through the same workflow."
  },
  {
    icon: UsersRound,
    title: "Scoped organization workspaces",
    copy: "Organization roles see tenant-scoped workloads and explicitly granted actions. Platform administration stays outside their workspace."
  },
  {
    icon: FileClock,
    title: "Operational history",
    copy: "Privileged actions and deployment events retain actor, target, result and timing context for later review."
  }
] as const;

const securityPoints = [
  {
    icon: Network,
    title: "A clear control boundary",
    copy: "The browser talks to the Noderaft control plane. Docker access stays on the server-to-agent path."
  },
  {
    icon: LockKeyhole,
    title: "Server-side authorization",
    copy: "Role and tenant checks are enforced in API routes and service logic, not left to hidden navigation or browser state."
  },
  {
    icon: Container,
    title: "Constrained agent actions",
    copy: "The agent exposes explicit container and Compose operations. Noderaft does not provide an arbitrary shell command endpoint."
  },
  {
    icon: ShieldCheck,
    title: "Protected control data",
    copy: "Session tokens are stored as hashes, browser sessions use httpOnly cookies, and managed secret values are encrypted at rest."
  }
] as const;

function PlatformCta({ label = "Open platform", compact = false }: { label?: string; compact?: boolean }): React.JSX.Element {
  return (
    <a
      href={platformLink}
      className={`inline-flex items-center justify-center gap-2 rounded-control bg-brand font-medium text-brand-contrast transition-colors hover:bg-brand-hover ${compact ? "h-9 px-4 text-sm" : "h-12 px-6 text-[0.9375rem]"}`}
    >
      {label}
      <ExternalLink aria-hidden="true" className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
    </a>
  );
}

function ProductPreview(): React.JSX.Element {
  return (
    <div className="relative min-w-0" aria-label="Sanitized Noderaft product preview">
      <div className="absolute -inset-8 -z-10 rounded-full bg-brand/10 blur-3xl" aria-hidden="true" />
      <div className="overflow-hidden rounded-[0.875rem] border border-border bg-surface-deck shadow-overlay">
        <div className="flex min-w-0 items-center gap-2 border-b border-border bg-surface-raised px-4 py-3">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="h-2 w-2 rounded-full bg-border-strong" />
            <span className="h-2 w-2 rounded-full bg-border-strong" />
            <span className="h-2 w-2 rounded-full bg-border-strong" />
          </div>
          <span className="min-w-0 truncate font-mono text-[0.6875rem] text-text-subtle">Noderaft · sample workspace</span>
          <span className="ml-auto shrink-0 rounded-md border border-selected-border/30 bg-selected px-2 py-0.5 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-brand-hover">
            demo data
          </span>
        </div>

        <div className="space-y-4 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-lg font-semibold tracking-[-0.02em]">Overview</p>
              <p className="mt-1 text-xs text-text-subtle">Operational state across the demo fleet</p>
            </div>
            <span className="mt-1 inline-flex shrink-0 items-center gap-1.5 font-mono text-[0.6875rem] text-success-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              nominal
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            <div className="rounded-[0.625rem] border border-border bg-surface-raised p-3">
              <p className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-text-muted">Attention</p>
              <p className="mt-2 font-mono text-xl font-medium">Clear</p>
            </div>
            <div className="rounded-[0.625rem] border border-border bg-surface-raised p-3">
              <p className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-text-muted">Operations</p>
              <p className="mt-2 font-mono text-xl font-medium">1 <span className="text-xs text-text-subtle">active</span></p>
            </div>
            <div className="col-span-2 rounded-[0.625rem] border border-border bg-surface-raised p-3 sm:col-span-1">
              <p className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-text-muted">Node link</p>
              <p className="mt-2 font-mono text-xl font-medium">Online</p>
            </div>
          </div>

          <div className="rounded-[0.625rem] border border-border bg-surface-hull/40">
            <div className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">Harbor API</p>
                <p className="mt-0.5 font-mono text-[0.6875rem] text-text-subtle">demo-edge · managed workload</p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2 py-0.5 text-[0.6875rem] text-text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-success" /> healthy
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 px-3.5 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">Beacon Worker</p>
                <p className="mt-0.5 font-mono text-[0.6875rem] text-text-subtle">demo-edge · managed workload</p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-info/20 bg-info/10 px-2 py-0.5 text-[0.6875rem] text-info-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-info" /> deploying
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 rounded-[0.625rem] border border-border bg-surface-raised/50 p-3 text-xs text-text-muted">
            <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-success" />
            Healthy state stays quiet; active work remains visible.
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandingPage(): React.JSX.Element {
  return (
    <div className="min-h-screen overflow-x-clip bg-surface-hull text-text">
      <header className="sticky top-0 z-50 border-b border-border bg-surface-hull/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[75rem] items-center justify-between gap-5 px-5 sm:px-8">
          <a href="#top" aria-label="Noderaft home" className="shrink-0 text-text">
            <Image src="/brand/logo-horizontal-dark.svg" width={280} height={64} alt="Noderaft" priority className="h-8 w-auto" />
          </a>

          <nav aria-label="Primary navigation" className="hidden items-center gap-7 text-sm md:flex">
            <a href="#how-it-works" className="text-text-muted transition-colors hover:text-text">How it works</a>
            <a href="#capabilities" className="text-text-muted transition-colors hover:text-text">Capabilities</a>
            <a href="#security" className="text-text-muted transition-colors hover:text-text">Security</a>
          </nav>

          <div className="hidden md:block">
            <PlatformCta compact />
          </div>

          <details className="group relative md:hidden">
            <summary className="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-control border border-border bg-surface-deck text-text [&::-webkit-details-marker]:hidden">
              <Menu aria-hidden="true" className="h-5 w-5" />
              <span className="sr-only">Open navigation</span>
            </summary>
            <nav aria-label="Mobile navigation" className="absolute right-0 top-12 w-[min(18rem,calc(100vw-2.5rem))] rounded-panel border border-border bg-surface-overlay p-2 shadow-overlay">
              <a href="#how-it-works" className="block rounded-control px-3 py-2.5 text-sm text-text-muted hover:bg-surface-raised hover:text-text">How it works</a>
              <a href="#capabilities" className="block rounded-control px-3 py-2.5 text-sm text-text-muted hover:bg-surface-raised hover:text-text">Capabilities</a>
              <a href="#security" className="block rounded-control px-3 py-2.5 text-sm text-text-muted hover:bg-surface-raised hover:text-text">Security</a>
              <a href={platformLink} className="mt-2 flex h-10 items-center justify-center gap-2 rounded-control bg-brand px-4 text-sm font-medium text-brand-contrast hover:bg-brand-hover">
                Open platform <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              </a>
            </nav>
          </details>
        </div>
      </header>

      <main id="top">
        <section className="relative border-b border-border">
          <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_12%_0%,rgb(var(--brand-accent)/0.14),transparent_48%),radial-gradient(circle_at_88%_22%,rgb(var(--state-success)/0.07),transparent_42%)]" aria-hidden="true" />
          <div className="mx-auto grid max-w-[75rem] items-center gap-12 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[1.03fr_0.97fr] lg:gap-14 lg:py-24">
            <div className="min-w-0">
              <p className="eyebrow">Self-hosted Docker fleet operations</p>
              <h1 className="mt-5 max-w-[11ch] text-[clamp(2.75rem,7vw,4rem)] font-semibold leading-[1.02] tracking-[-0.045em] text-balance">
                Your fleet,<br />on one deck.
              </h1>
              <p className="mt-6 max-w-[36rem] text-lg leading-8 text-text-muted sm:text-[1.1875rem]">
                See the state that needs you, manage Compose releases, and give each organization a scoped workspace — without putting Docker in the browser.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <PlatformCta />
                <a href="#how-it-works" className="inline-flex h-12 items-center justify-center gap-2 rounded-control border border-border bg-surface-deck px-6 text-[0.9375rem] text-text transition-colors hover:border-border-strong hover:bg-surface-raised">
                  Explore the workflow <ArrowRight aria-hidden="true" className="h-4 w-4" />
                </a>
              </div>
              <p className="mt-5 max-w-[34rem] text-xs leading-5 text-text-subtle">
                Noderaft is currently available to authorized platform users. Installation, licensing and commercial terms are not published here.
              </p>
            </div>

            <ProductPreview />
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-20 border-b border-border">
          <div className="mx-auto max-w-[75rem] px-5 py-16 sm:px-8 sm:py-20">
            <p className="eyebrow">How it works</p>
            <h2 className="mt-4 max-w-[19ch] text-3xl font-semibold leading-tight tracking-[-0.035em] sm:text-[2.375rem]">
              A control plane with boundaries you can reason about.
            </h2>
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {workflow.map(({ icon: Icon, title, copy }, index) => (
                <article key={title} className="rounded-panel border border-border bg-surface-deck p-6 sm:p-7">
                  <div className="flex items-center justify-between">
                    <span className="grid h-10 w-10 place-items-center rounded-[0.625rem] bg-surface-raised text-brand">
                      <Icon aria-hidden="true" className="h-[1.125rem] w-[1.125rem]" />
                    </span>
                    <span className="font-mono text-xs text-text-subtle">0{index + 1}</span>
                  </div>
                  <h3 className="mt-5 text-lg font-semibold">{title}</h3>
                  <p className="mt-2 text-[0.9375rem] leading-6 text-text-muted">{copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="capabilities" className="scroll-mt-20 border-b border-border bg-[radial-gradient(circle_at_82%_0%,rgb(var(--brand-accent)/0.07),transparent_45%)]">
          <div className="mx-auto max-w-[75rem] px-5 py-16 sm:px-8 sm:py-20">
            <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
              <div>
                <p className="eyebrow">Operational clarity</p>
                <h2 className="mt-4 max-w-[14ch] text-3xl font-semibold leading-tight tracking-[-0.035em] sm:text-[2.375rem]">
                  Built around the work, not the Docker object list.
                </h2>
                <p className="mt-5 max-w-[31rem] text-base leading-7 text-text-muted">
                  Noderaft keeps runtime state, managed releases and operator actions connected to the workload they belong to.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {capabilities.map(({ icon: Icon, title, copy }) => (
                  <article key={title} className="rounded-panel border border-border bg-surface-deck/90 p-5 sm:p-6">
                    <Icon aria-hidden="true" className="h-5 w-5 text-brand" />
                    <h3 className="mt-4 font-semibold">{title}</h3>
                    <p className="mt-2 text-sm leading-[1.45rem] text-text-muted">{copy}</p>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="security" className="scroll-mt-20 border-b border-border">
          <div className="mx-auto max-w-[75rem] px-5 py-16 sm:px-8 sm:py-20">
            <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
              <div>
                <p className="eyebrow">Security architecture</p>
                <h2 className="mt-4 text-3xl font-semibold leading-tight tracking-[-0.035em] sm:text-[2.375rem]">Explicit controls. No magic claims.</h2>
              </div>
              <p className="max-w-[30rem] text-sm leading-6 text-text-muted">
                The product reduces exposure through constrained paths and least-privilege controls; it does not present those controls as a blanket security guarantee.
              </p>
            </div>
            <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {securityPoints.map(({ icon: Icon, title, copy }) => (
                <article key={title} className="rounded-panel border border-border bg-surface-deck p-5 sm:p-6">
                  <Icon aria-hidden="true" className="h-5 w-5 text-brand" />
                  <h3 className="mt-4 text-[0.9375rem] font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-[1.4rem] text-text-muted">{copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-[radial-gradient(circle_at_50%_0%,rgb(var(--brand-accent)/0.1),transparent_62%)]">
          <div className="mx-auto flex max-w-[75rem] flex-col items-center px-5 py-20 text-center sm:px-8 sm:py-24">
            <Image src="/brand/logo-mark.svg" width={64} height={64} alt="" aria-hidden="true" className="h-14 w-14" />
            <p className="eyebrow mt-6">Noderaft platform</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em] sm:text-[2.375rem]">Ready to come aboard?</h2>
            <p className="mt-4 max-w-[31rem] text-base leading-7 text-text-muted">
              Sign in to the Noderaft platform with an account issued by your administrator.
            </p>
            <div className="mt-7">
              <PlatformCta label="Sign in" />
            </div>
            <p className="mt-4 font-mono text-xs text-text-subtle">platform.noderaft.ee</p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-[75rem] flex-col gap-5 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Image src="/brand/logo-mark.svg" width={64} height={64} alt="" aria-hidden="true" className="h-7 w-7 shrink-0" />
            <span className="text-sm font-semibold">Noderaft</span>
            <span className="hidden font-mono text-[0.6875rem] text-text-subtle sm:inline">Your fleet, on one deck.</span>
          </div>
          <div className="flex items-center gap-5 text-xs text-text-muted">
            <a href="#top" className="hover:text-text">Back to top</a>
            <a href={platformLink} className="hover:text-text">Open platform</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
