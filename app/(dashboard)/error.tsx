"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/ui/state-panel";
import { DocumentTitle } from "@/components/brand/document-title";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }): React.JSX.Element {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      <DocumentTitle title="Unable to load page" />
      <StatePanel
        tone="error"
        title="Unable to load this page"
        description="Noderaft could not load this view. No infrastructure changes were made."
        action={<Button onClick={reset}>Try again</Button>}
      />
    </>
  );
}
