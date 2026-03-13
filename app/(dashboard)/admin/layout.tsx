import { requirePageRole } from "@/server/auth/guards";

export default async function AdminLayout({
  children
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requirePageRole("ADMIN");
  return <>{children}</>;
}
