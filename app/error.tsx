"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { NoderaftLogo } from "@/components/brand/noderaft-logo";
import { DocumentTitle } from "@/components/brand/document-title";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }): React.JSX.Element {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      <DocumentTitle title="Something went wrong" />
      <main className="flex min-h-screen items-center justify-center p-gutter">
        <section className="panel w-full max-w-lg p-8 text-center" role="alert">
          <NoderaftLogo compact className="mx-auto" priority />
          <p className="eyebrow mt-6">Noderaft</p>
          <h1 className="page-title mt-2">Something went wrong</h1>
          <p className="mt-3 text-text-muted">The control panel hit an unexpected error. Your infrastructure was not changed.</p>
          <Button className="mt-6" onClick={reset}>Try again</Button>
        </section>
      </main>
    </>
  );
}
