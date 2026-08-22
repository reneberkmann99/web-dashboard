import { requirePageCapability } from "@/server/auth/guards";

export default async function ClientTeamLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  await requirePageCapability("user.manage");
  return <>{children}</>;
}
