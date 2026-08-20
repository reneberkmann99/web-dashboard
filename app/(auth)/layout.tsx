import type { Metadata } from "next";
import { PlatformProviders } from "@/components/providers/platform-providers";

export const metadata: Metadata = {
  robots: { index: false, follow: false }
};

export default function AuthLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <PlatformProviders>{children}</PlatformProviders>;
}
