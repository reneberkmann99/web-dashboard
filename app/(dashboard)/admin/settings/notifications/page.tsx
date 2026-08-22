"use client";

import { AlertingConsole } from "@/components/alerting/alerting-console";

export default function AdminAlertingPage(): React.JSX.Element {
  return <AlertingConsole apiBase="/api/admin/notifications" mode="admin" />;
}
