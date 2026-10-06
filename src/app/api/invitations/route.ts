import { inspectInvitation } from "@/server/auth/invitations";
import { errorResponse, json } from "@/server/http";
import { requireInvitationAttempt } from "@/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try {
    await requireInvitationAttempt(request);
    const invitation = await inspectInvitation(
      new URL(request.url).searchParams.get("token") || "",
    );
    const response = json({ invitation });
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
