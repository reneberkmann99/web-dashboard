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
  }

  // Security: never expose internal error details to the client.
  // Log the actual error for server-side diagnosis only.
  console.error("[HostPanel] unhandled route error:", error);
  return fail("INTERNAL_ERROR", "Unexpected server error", 500);
}
