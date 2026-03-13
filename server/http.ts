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
  }

  return fail("INTERNAL_ERROR", "Unexpected server error", 500);
}
