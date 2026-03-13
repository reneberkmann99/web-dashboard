import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";

export default async function HomePage(): Promise<never> {
  const session = await getCurrentSession();
  if (!session) {
    redirect("/login");
  }

  redirect(session.role === "ADMIN" ? "/admin" : "/client");
}
