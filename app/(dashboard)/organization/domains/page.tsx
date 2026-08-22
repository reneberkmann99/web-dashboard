"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { DomainsConsole } from "@/components/domains/domains-console";

type MePayload = { user: { role: string; clientAccountName: string | null } };

export default function OrganizationDomainsPage(): React.JSX.Element {
  const query = useQuery({ queryKey: ["organization-domains-me"], queryFn: () => apiFetch<MePayload>("/api/auth/me") });
  // Only CLIENT_ADMIN actually holds domain.manage (server/auth/policy.ts) —
  // the deprecated legacy CLIENT role is excluded here the same way it's
  // excluded from every other admin-ish organization surface (e.g. Alerting,
  // gated behind client.manage), so this page never offers a control that
  // the server would reject with FORBIDDEN.
  const canManage = query.data?.user.role === "CLIENT_ADMIN";
  return <DomainsConsole canManage={canManage} organizationName={query.data?.user.clientAccountName} />;
}
