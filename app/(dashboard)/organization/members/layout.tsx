import { requirePageCapability } from "@/server/auth/guards";

export default async function OrganizationMembersLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  await requirePageCapability("user.manage");
  return <>{children}</>;
}
