import { redeemInvitation, redeemSchema } from "@/server/auth/invitations";
import { errorResponse, json, readJson } from "@/server/http";
import { enforceSameOrigin, requireInvitationAttempt } from "@/server/security";

export const runtime = "nodejs";
// Redeems an administrator-issued invitation to create an account.
// The invitation acceptance form invokes this after attempt controls.
export async function POST(request: Request): Promise<Response> {
  try {
    enforceSameOrigin(request);
    await requireInvitationAttempt(request);
    await redeemInvitation(
      redeemSchema.parse(await readJson(request, 8 * 1024)),
    );
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
