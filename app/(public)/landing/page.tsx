import type { Metadata } from "next";
import { LandingPage } from "@/components/landing/landing-page";
import { BRAND } from "@/lib/brand";

const title = "Noderaft — Docker fleet operations, on one deck";
const description = "A self-hosted control plane for Docker nodes, workloads and containers, with managed Compose releases and scoped client access.";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: {
    canonical: `${BRAND.publicSiteUrl}/`
  },
  openGraph: {
    type: "website",
    url: `${BRAND.publicSiteUrl}/`,
    siteName: BRAND.productName,
    title,
    description,
    images: [
      {
        url: `${BRAND.publicSiteUrl}/brand/og-image.png`,
        width: 1200,
        height: 630,
        alt: "Noderaft — Your fleet, on one deck."
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [`${BRAND.publicSiteUrl}/brand/og-image.png`]
  }
};

export default function PublicLandingPage(): React.JSX.Element {
  return <LandingPage />;
}
