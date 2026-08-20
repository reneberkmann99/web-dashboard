import type { Metadata } from "next";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@/app/globals.css";
import { QueryProvider } from "@/components/providers/query-provider";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://panel.noderaft.io"),
  title: {
    default: "Noderaft",
    template: "%s · Noderaft"
  },
  description: "Self-hosted control panel for nodes, workloads and containers.",
  applicationName: "Noderaft",
  icons: {
    icon: [
      { url: "/brand/favicon.svg", type: "image/svg+xml" },
      { url: "/brand/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" }
    ],
    apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
  },
  manifest: "/manifest.webmanifest",
  openGraph: {
    type: "website",
    siteName: "Noderaft",
    title: "Noderaft — Your fleet, on one deck.",
    description: "Self-hosted control panel for nodes, workloads and containers.",
    images: [{ url: "/brand/og-image.png", width: 1200, height: 630, alt: "Noderaft — Your fleet, on one deck." }]
  },
  twitter: {
    card: "summary_large_image",
    title: "Noderaft — Your fleet, on one deck.",
    description: "Self-hosted control panel for nodes, workloads and containers.",
    images: ["/brand/og-image.png"]
  }
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
      </body>
    </html>
  );
}
