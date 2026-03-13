import { requirePageRole } from "@/server/auth/guards";

export default async function ClientLayout({
  children
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requirePageRole("CLIENT");
  return <>{children}</>;
}
