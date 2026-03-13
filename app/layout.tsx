import type { Metadata } from "next";
import "@/app/globals.css";
import { QueryProvider } from "@/components/providers/query-provider";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "HostPanel",
  description: "SaaS hosting dashboard with RBAC, node agents, and rootless Docker orchestration"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <html lang="en" className="dark">
      <body>
        <QueryProvider>
          {children}
          <Toaster theme="dark" richColors />
        </QueryProvider>
      </body>
    </html>
  );
}
