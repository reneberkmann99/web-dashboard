import { BRAND } from "@/lib/brand";

const PUBLIC_HOST = new URL(BRAND.publicSiteUrl).hostname;

export function robotsTextForHostname(hostname: string): string {
  if (hostname.toLowerCase() !== PUBLIC_HOST) {
    return "User-agent: *\nDisallow: /\n";
  }

  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin/",
    "Disallow: /client/",
    "Disallow: /organization/",
    "Disallow: /organizations/",
    "Disallow: /api/",
    "Disallow: /login",
    "Disallow: /activate",
    "Disallow: /forbidden",
    `Sitemap: ${BRAND.publicSiteUrl}/sitemap.xml`,
    `Host: ${PUBLIC_HOST}`,
    ""
  ].join("\n");
}
