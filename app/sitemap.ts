import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${BRAND.publicSiteUrl}/`,
      changeFrequency: "monthly",
      priority: 1
    }
  ];
}
