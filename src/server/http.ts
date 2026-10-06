import "server-only";
import { ZodError } from "zod";

export class AppError extends Error {
  public retryAfter?: number;
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError)
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
          ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
        },
      },
      {
        status: error.status,
        headers: {
          "Cache-Control": "no-store",
          ...(error.retryAfter
            ? { "Retry-After": String(error.retryAfter) }
            : {}),
        },
      },
    );
  if (error instanceof ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of error.issues)
      (fields[issue.path.join(".")] ??= []).push(issue.message);
    return Response.json(
      {
        error: {
          code: "validation_error",
          message: "Please check the submitted fields.",
          fields,
        },
      },
      { status: 422 },
    );
  }
  // Avoid exposing provider bodies, request headers, or credentials in logs/responses.
  console.error("Request failed", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  return Response.json(
    {
      error: {
        code: "internal_error",
        message: "The request could not be completed. Please try again.",
      },
    },
    { status: 500 },
  );
}
export const apiError = errorResponse;
export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export async function readJson(
  request: Request,
  maxBytes = 128 * 1024,
): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new AppError(
      "unsupported_media_type",
      "JSON content is required.",
      415,
    );
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new AppError(
      "payload_too_large",
      "The submitted content is too large.",
      413,
    );
  if (!request.body)
    throw new AppError("invalid_json", "A JSON body is required.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError(
        "payload_too_large",
        "The submitted content is too large.",
        413,
      );
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AppError(
      "invalid_json",
      "The request body must be valid JSON.",
      400,
    );
  }
}
