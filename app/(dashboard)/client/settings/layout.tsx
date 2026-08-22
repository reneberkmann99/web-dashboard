import { requirePageCapability } from "@/server/auth/guards";

export default async function ClientSettingsLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  await requirePageCapability("client.manage");
  return <>{children}</>;
}
