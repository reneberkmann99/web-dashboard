import { requirePageCapability } from "@/server/auth/guards";

export default async function OrganizationWorkloadCreateLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  await requirePageCapability("workload.create");
  return <>{children}</>;
}
