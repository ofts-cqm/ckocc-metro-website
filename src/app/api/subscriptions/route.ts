import {
  requestSubscription,
  subscriptionSchema,
} from "@/server/auth/invitations";
import { sendSubscriberInvitation } from "@/server/email/subscriber-invitations";
import { emailEnabled } from "@/server/email/config";
import { AppError, errorResponse, json, readJson } from "@/server/http";
import {
  enforceSameOrigin,
  requireAnonymousWrite,
  enforceRateLimits,
} from "@/server/security";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    enforceSameOrigin(request);
    const input = subscriptionSchema.parse(await readJson(request, 8192));
    await requireAnonymousWrite(
      request,
      "request",
      input.challenge,
      input.idempotencyKey,
    );
    await enforceRateLimits([
      { key: `subscribe-address:${input.email}`, max: 3, seconds: 86400 },
      { key: "subscribe-global", max: 30, seconds: 3600 },
    ]);
    if (!emailEnabled())
      throw new AppError(
        "email_unavailable",
        "Email subscriptions are temporarily unavailable.",
        503,
      );
    const invitationId = await requestSubscription(input);
    const delivery = await sendSubscriberInvitation(invitationId);
    if (delivery === "pending")
      throw new AppError(
        "subscription_delivery_pending",
        "Your invitation is queued or being sent. Please wait before checking again.",
        409,
      );
    if (delivery === "failed")
      throw new AppError(
        "subscription_delivery_failed",
        "We could not send your invitation. Contact an administrator for help.",
        503,
      );
    if (delivery !== "sent")
      throw new AppError(
        "subscription_delivery_unknown",
        "We could not confirm whether your invitation was sent. Check your inbox and spam folder. If it does not arrive, contact an administrator; another email has not been sent.",
        503,
      );
    return json({ ok: true, delivery: "sent" });
  } catch (error) {
    return errorResponse(error);
  }
}
