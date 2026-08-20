import Link from "next/link";
import type { Metadata } from "next";
import { ShieldX } from "lucide-react";

export const metadata: Metadata = { title: "Access denied" };

export default function ForbiddenPage(): React.JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center p-gutter">
      <section className="panel w-full max-w-lg p-8 text-center">
        <ShieldX className="mx-auto h-8 w-8 text-critical-foreground" />
        <p className="eyebrow mt-6">403 · Access denied</p>
        <h1 className="page-title mt-2">You cannot open this page</h1>
        <p className="mt-3 text-text-muted">Your Noderaft account does not have permission for this resource.</p>
        <Link href="/" className="mt-6 inline-flex rounded-control border border-selected-border/40 bg-selected px-4 py-2 text-sm text-brand-hover">
          Return to overview
        </Link>
      </section>
    </main>
  );
}
