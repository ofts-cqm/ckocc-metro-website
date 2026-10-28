import { optionalUser } from "@/server/auth/authorize";
import { errorResponse, json } from "@/server/http";
import {
  guestMentionRemaining,
  mentionSuggestions,
} from "@/server/operations/mentions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Returns mention suggestions for comments and general thoughts.
// The composer invokes this as the author types a mention.
export async function GET(request: Request): Promise<Response> {
  try {
    const user = await optionalUser(request);
    const search = new URL(request.url).searchParams.get("q") ?? "";
    return json({
      suggestions: await mentionSuggestions(search),
      remaining: user ? null : await guestMentionRemaining(request),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
