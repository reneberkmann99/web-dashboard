"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { DomainsConsole } from "@/components/domains/domains-console";

type MePayload = { user: { role: string; clientAccountName: string | null } };

export default function OrganizationDomainsPage(): React.JSX.Element {
  const query = useQuery({ queryKey: ["organization-domains-me"], queryFn: () => apiFetch<MePayload>("/api/auth/me") });
  const canManage = query.data?.user.role === "CLIENT_ADMIN" || query.data?.user.role === "CLIENT";
  return <DomainsConsole canManage={canManage} organizationName={query.data?.user.clientAccountName} />;
}
