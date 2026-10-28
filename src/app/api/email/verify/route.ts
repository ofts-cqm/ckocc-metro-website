import { consumeEmailToken, emailTokenSchema } from "@/server/email/accounts";
import { errorResponse, json, readJson } from "@/server/http";
import { enforceSameOrigin, requireInvitationAttempt } from "@/server/security";
export const runtime = "nodejs";
// Consumes an email verification token from a verification link.
// The email settings workflow invokes this after the recipient opens the link.
export async function POST(request: Request) {
  try {
    enforceSameOrigin(request);
    await requireInvitationAttempt(request);
    const { token } = emailTokenSchema.parse(await readJson(request, 2048));
    return json(await consumeEmailToken(token, "verify"));
  } catch (error) {
    return errorResponse(error);
  }
}
