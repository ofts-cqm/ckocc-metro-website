import { getAuth, withLoginContext } from "@/server/auth/config";
import { redeemInvitation, redeemSchema } from "@/server/auth/invitations";
import { errorResponse, json, readJson } from "@/server/http";
import { enforceSameOrigin, requireInvitationAttempt } from "@/server/security";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  try {
    enforceSameOrigin(request);
    await requireInvitationAttempt(request);
    const input = redeemSchema.parse(await readJson(request, 8 * 1024));
    const result = await redeemInvitation(input);
    if (result.subscribed) {
      try {
        const login = await withLoginContext(() =>
          getAuth().handler(
            new Request(new URL("/api/auth/sign-in/email", request.url), {
              method: "POST",
              headers: request.headers,
              body: JSON.stringify({
                email: result.email,
                password: input.password,
              }),
            }),
          ),
        );
        const response = json({
          ok: true,
          subscribed: true,
          signedIn: login.ok,
        });
        for (const cookie of login.headers.getSetCookie())
          response.headers.append("Set-Cookie", cookie);
        return response;
      } catch {
        // Activation is committed. A session failure must not invite redemption of a consumed link.
        return json({ ok: true, subscribed: true, signedIn: false });
      }
    }
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
