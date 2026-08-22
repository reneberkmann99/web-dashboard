import { requirePageCapability } from "@/server/auth/guards";

export default async function OrganizationDomainsLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  await requirePageCapability("domain.view");
  return <>{children}</>;
}
