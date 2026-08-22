import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status });
}

export function fail(code: string, message: string, status = 400, details?: unknown): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code,
        message,
        ...(details ? { details } : {})
      }
    },
    { status }
  );
}

/**
 * Security: converts errors to safe client-facing responses.
 * - ZodError → 400 with flattened field errors (safe, contains only field names).
 * - Known sentinel strings (UNAUTHORIZED, FORBIDDEN, NOT_FOUND) → appropriate HTTP status.
 * - All other errors → generic 500; actual error is logged server-side only.
 */
export function fromError(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    return fail("VALIDATION_ERROR", "Invalid request payload", 400, error.flatten());
  }

  if (error instanceof Error) {
    if (error.message === "UNAUTHORIZED") {
      return fail("UNAUTHORIZED", "Authentication required", 401);
    }
    if (error.message === "FORBIDDEN") {
      return fail("FORBIDDEN", "You are not allowed to perform this action", 403);
    }
    if (error.message === "NOT_FOUND") {
      return fail("NOT_FOUND", "Resource not found", 404);
    }
    if (error.message === "LAST_ADMIN") {
      return fail("LAST_ADMIN", "Cannot remove the last active administrator", 409);
    }
    if (error.message === "ALREADY_ACTIVE") {
      return fail("ALREADY_ACTIVE", "This account is already active", 409);
    }
    if (error.message === "ORGANIZATION_REQUIRED") {
      return fail("ORGANIZATION_REQUIRED", "An organization role requires an organization membership", 400);
    }
    if (error.message === "MANAGED_WORKLOAD") {
      return fail("MANAGED_WORKLOAD", "This workload is managed by Noderaft — remove it from management before deleting", 409);
    }
    if (error.message === "MANAGED_CONTAINER") {
      return fail("MANAGED_CONTAINER", "This container is a managed workload service — edit the workload revision instead of deleting it directly", 409);
    }
    if (error.message === "ATTENTION_NOT_ACTIVE") {
      return fail("ATTENTION_NOT_ACTIVE", "The attention condition is no longer active", 409);
    }
    if (error.message === "INVALID_TIME_RANGE" || error.message === "INVALID_SCOPE") {
      return fail(error.message, "Invalid lifecycle scope or time range", 422);
    }
    if (error.message === "NOTIFICATION_ENCRYPTION_NOT_CONFIGURED") {
      return fail(error.message, "Notification credential encryption is not configured", 503);
    }
    if (error.message === "SMTP_ENCRYPTION_NOT_CONFIGURED") {
      return fail(error.message, "SMTP credential encryption is not configured", 503);
    }
    if (error.message === "SMTP_CONFIGURATION_INVALID") {
      return fail(error.message, "SMTP settings are incomplete or invalid", 422);
    }
    if (error.message === "SMTP_DISABLED") {
      return fail(error.message, "Email delivery is disabled", 409);
    }
    if (
      error.message.startsWith("WEBHOOK_") ||
      error.message === "INVALID_AUTH_HEADER" ||
      error.message === "INVALID_SIGNING_SECRET" ||
      error.message === "HOSTPANEL_PUBLIC_BASE_URL_MUST_BE_HTTPS" ||
      error.message === "URL_REQUIRED" ||
      error.message === "EMAIL_RECIPIENTS_REQUIRED" ||
      error.message === "TOO_MANY_EMAIL_RECIPIENTS" ||
      error.message === "INVALID_EMAIL_RECIPIENT"
    ) {
      return fail(error.message, "Notification destination configuration was rejected", 422);
    }
    if (error.message === "NAME_REQUIRED" || error.message === "EVENT_TYPES_REQUIRED") {
      return fail(error.message, "Invalid alerting configuration", 422);
    }
    if (error.message === "ORGANIZATION_SCOPE_REQUIRES_CLIENT" || error.message === "DESTINATION_SCOPE_MISMATCH") {
      return fail(error.message, "This rule's scope does not match the selected destination's organization", 422);
    }
  }

  // Security: never expose internal error details to the client.
  // Log the actual error for server-side diagnosis only.
  console.error("[Noderaft] unhandled route error:", error);
  return fail("INTERNAL_ERROR", "Unexpected server error", 500);
}
