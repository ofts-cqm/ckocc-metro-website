import { redeemInvitation, redeemSchema } from "@/server/auth/invitations";
import { errorResponse, json, readJson } from "@/server/http";
import { enforceSameOrigin, requireInvitationAttempt } from "@/server/security";

export const runtime = "nodejs";
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
