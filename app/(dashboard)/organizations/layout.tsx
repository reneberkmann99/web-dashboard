import { requirePageRole } from "@/server/auth/guards";

export default async function OrganizationsLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  await requirePageRole("ADMIN");
  return <>{children}</>;
}
