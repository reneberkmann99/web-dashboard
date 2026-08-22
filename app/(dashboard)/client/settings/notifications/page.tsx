"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { AlertingConsole } from "@/components/alerting/alerting-console";

type MePayload = { user: { clientAccountName: string | null } };

export default function OrganizationAlertingPage(): React.JSX.Element {
  const query = useQuery({ queryKey: ["organization-alerting-me"], queryFn: () => apiFetch<MePayload>("/api/auth/me") });
  return <AlertingConsole apiBase="/api/client/notifications" mode="organization" organizationName={query.data?.user.clientAccountName} />;
}
