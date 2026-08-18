import { ApiResponse } from "@/types/api";

function getCsrfCookie(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const match = document.cookie.match(/(?:^|;\s*)hostpanel_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isMutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined)
  };

  // Double-submit CSRF: attach the non-HttpOnly CSRF cookie value as a header
  // on every state-changing request; the middleware compares the two.
  if (isMutating) {
    const csrf = getCsrfCookie();
    if (csrf) {
      headers["X-CSRF-Token"] = csrf;
    }
  }

  const response = await fetch(input, {
    ...init,
    headers,
    credentials: "include"
  });

  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.ok) {
    throw new Error(payload.error.message);
  }
  return payload.data;
}
