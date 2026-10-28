import { requireUser } from "@/server/auth/authorize";
import { AppError, errorResponse, json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Returns the active account or null for an unauthenticated visitor.
// Client session checks invoke this while loading signed-in features.
export async function GET(request: Request): Promise<Response> {
  try {
    return json({ user: await requireUser(request) });
  } catch (error) {
    if (error instanceof AppError && error.status === 401)
      return json({ user: null });
    return errorResponse(error);
  }
}
