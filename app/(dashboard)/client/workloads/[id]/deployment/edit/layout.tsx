import { requirePageCapability } from "@/server/auth/guards";

export default async function ClientWorkloadEditLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  await requirePageCapability("workload.edit");
  return <>{children}</>;
}
