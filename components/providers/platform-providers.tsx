"use client";

import { Toaster } from "sonner";
import { QueryProvider } from "@/components/providers/query-provider";

export function PlatformProviders({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <QueryProvider>
      {children}
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: "!border-border !bg-surface-overlay !text-text !shadow-overlay",
            description: "!text-text-muted",
            success: "!border-success/40",
            warning: "!border-warning/40",
            error: "!border-critical/40",
            info: "!border-info/40"
          }
        }}
      />
    </QueryProvider>
  );
}
