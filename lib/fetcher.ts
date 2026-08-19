import { ApiErrorPayload, ApiResponse } from "@/types/api";

/**
 * Error thrown by apiFetch with the backend error CODE preserved (not just the
 * message). UI code switches on `error.code` (e.g. PLAN_STALE) while the
 * message remains human-readable for toasts.
 */
export class ApiError extends Error {
  code: string;
  details?: unknown;

  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.name = "ApiError";
    this.code = payload.code;
    this.details = payload.details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

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
    throw new ApiError(payload.error);
  }
  return payload.data;
}
