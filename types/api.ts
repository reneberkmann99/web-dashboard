export type ApiErrorPayload = {
  code: string;
  message: string;
  details?: unknown;
};

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiFailure = {
  ok: false;
  error: ApiErrorPayload;
};

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
