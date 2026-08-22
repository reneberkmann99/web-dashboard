import { requirePageCapability } from "@/server/auth/guards";

export default async function ClientWorkloadCreateLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  await requirePageCapability("workload.create");
  return <>{children}</>;
}
