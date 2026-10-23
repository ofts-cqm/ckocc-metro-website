import { z } from "zod";
import { requireAdmin } from "@/server/auth/authorize";
import { enforceSameOrigin, enforceRateLimits } from "@/server/security";
import { json } from "@/server/http";
import { idempotencyKeySchema } from "@/lib/schemas";
import { route } from "@/server/operations/handlers";
import { acceptOperation, operationView } from "@/server/operations/store";
import { recordedPullRequest } from "@/server/operations/map-actions";
import { launchOperation } from "@/server/operations/outbox";
import { PipelineError } from "@/server/operations/errors";
import { reconcileCompletedMaintenance } from "@/server/operations/maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = route(async (request, context) => {
  enforceSameOrigin(request);
  const user = await requireAdmin(request);
  const id = z.uuid().parse((await context?.params)?.id);
  const operation = await acceptOperation({
    kind: "close-update",
    scope: `close-update:${user.id}:${id}`,
    key: idempotencyKeySchema.parse(request.headers.get("Idempotency-Key")),
    actorId: user.id,
    payload: { updateId: id },
    authorize: async () => {
      await enforceRateLimits([
        { key: `map-action:${user.id}`, max: 30, seconds: 3600 },
      ]);
      const { pr } = await recordedPullRequest(id);
      if (pr.merged) throw new PipelineError("pr_already_merged", 409);
      await reconcileCompletedMaintenance(id, user.id);
    },
  });
  await launchOperation(operation.id);
  return json({ operation: operationView(operation) }, 202);
});
