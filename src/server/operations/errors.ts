import { AppError } from "@/server/http";

/** Carries a stable operation error code and HTTP status through route and worker handling. */
export class PipelineError extends AppError {
  constructor(
    code: string,
    status = 422,
    public retryAfter?: number,
  ) {
    super(code, code.replaceAll("_", " "), status);
  }
}

/** Gets an HTTP status from a known error for API response handling. */
export function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

/** Converts worker failures to a safe public operation error code. */
export function safeErrorCode(error: unknown): string {
  if (error instanceof PipelineError) return error.code;
  const status = statusOf(error);
  if (status === 401 || status === 403) return "provider_access_denied";
  if (status === 429) return "provider_rate_limited";
  return "provider_unavailable";
}

/** Computes a retry delay for provider failures in the operation worker. */
export function providerBackoff(error: unknown): number {
  const headers = (error as { response?: { headers?: Record<string, string> } })
    ?.response?.headers;
  const delay = Number(headers?.["retry-after"]);
  const reset = Number(headers?.["x-ratelimit-reset"]) * 1000 - Date.now();
  return Math.min(
    86400,
    Math.max(
      60,
      Number.isFinite(delay) ? delay : 0,
      headers?.["x-ratelimit-remaining"] === "0" && Number.isFinite(reset)
        ? Math.ceil(reset / 1000)
        : 0,
    ),
  );
}
