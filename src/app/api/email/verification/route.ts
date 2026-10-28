import { requireUser } from "@/server/auth/authorize";
import {
  requestEmailVerification,
  verificationSchema,
} from "@/server/email/accounts";
import { launchPendingEmailJobs } from "@/server/email/jobs";
import { errorResponse, json, readJson } from "@/server/http";
import { enforceSameOrigin } from "@/server/security";
export const runtime = "nodejs";
// Requests a verification email for the signed-in account.
// The email settings workflow invokes this and queues durable email work.
export async function POST(request: Request) {
  try {
    enforceSameOrigin(request);
    const user = await requireUser(request);
    const result = await requestEmailVerification(
      request,
      user.id,
      verificationSchema.parse(await readJson(request, 2048)),
    );
    // The durable outbox survives a workflow service outage; repair starts remaining work.
    await launchPendingEmailJobs().catch(() =>
      console.error("Email workflow launch deferred to repair."),
    );
    return json(result, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
