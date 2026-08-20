import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin/", "/client/", "/api/", "/login", "/activate", "/forbidden"]
    },
    sitemap: `${BRAND.publicSiteUrl}/sitemap.xml`,
    host: BRAND.publicSiteUrl
  };
}
