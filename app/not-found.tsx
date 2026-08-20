import Link from "next/link";
import type { Metadata } from "next";
import { NoderaftLogo } from "@/components/brand/noderaft-logo";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound(): React.JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center p-gutter">
      <section className="panel w-full max-w-lg p-8 text-center">
        <NoderaftLogo compact className="mx-auto" priority />
        <p className="eyebrow mt-6">404 · Off course</p>
        <h1 className="page-title mt-2">Page not found</h1>
        <p className="mt-3 text-text-muted">The page may have moved, or you may not have access to it.</p>
        <Link href="/" className="mt-6 inline-flex rounded-control border border-selected-border/40 bg-selected px-4 py-2 text-sm text-brand-hover">
          Return to overview
        </Link>
      </section>
    </main>
  );
}
