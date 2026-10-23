import { z } from "zod";
import { requireAdmin } from "@/server/auth/authorize";
import { enforceSameOrigin, enforceRateLimits } from "@/server/security";
import { readJson, json, errorResponse, AppError } from "@/server/http";
import { repositoryConfig } from "@/server/github/client";
import { query } from "@/server/db";
import { idempotencyKeySchema } from "@/lib/schemas";
import { acceptOperation, operationView, type Operation } from "./store";
import { launchOperation } from "./outbox";
import { queueMaintenanceSync } from "./maintenance";
import { reviewMapUpdate, rollbackInput } from "./map-actions";
import { PipelineError, safeErrorCode } from "./errors";

type Context = { params: Promise<{ id: string }> };
const commit = z.string().regex(/^[a-f0-9]{40}$/);
function failure(error: unknown) {
  return errorResponse(
    error &&
      typeof error === "object" &&
      "status" in error &&
      !(error instanceof AppError)
      ? new PipelineError(safeErrorCode(error), 503)
      : error,
  );
}
export async function getReview(request: Request, context: Context) {
  try {
    const user = await requireAdmin(request, { fresh: false });
    await enforceRateLimits([
      { key: `map-review:${user.id}`, max: 600, seconds: 3600 },
    ]);
    const id = z
      .string()
      .uuid()
      .parse((await context.params).id);
    const review = await reviewMapUpdate(id);
    if (review.blockedReason === "maintenance_sync_required") {
      const operation = await queueMaintenanceSync(
        id,
        review.headSha,
        review.baseCommit,
      );
      review.maintenanceOperation = operationView(operation);
      review.blockedReason =
        ["failed", "outcome_unknown", "needs_reconciliation"].includes(
          operation.status,
        ) && !review.maintenanceOperation.retryAt
          ? operation.status === "needs_reconciliation"
            ? "stale_base_revision"
            : operation.status === "outcome_unknown"
              ? "maintenance_sync_unknown"
              : "maintenance_sync_failed"
          : "maintenance_sync_pending";
    }
    return json({ review });
  } catch (error) {
    return failure(error);
  }
}
async function submit(
  request: Request,
  context: Context,
  kind: "merge" | "rollback",
) {
  try {
    enforceSameOrigin(request);
    const user = await requireAdmin(request);
    const id = z
      .string()
      .uuid()
      .parse((await context.params).id);
    const key = idempotencyKeySchema.parse(
      request.headers.get("Idempotency-Key"),
    );
    const input: { baseCommit: string; headSha?: string } = (
      kind === "merge"
        ? z.object({ baseCommit: commit, headSha: commit }).strict()
        : z.object({ baseCommit: commit }).strict()
    ).parse(await readJson(request));
    const scope = `${kind}:${user.id}:${id}`;
    const prior = await query<Operation>(
      "SELECT * FROM metro_operations WHERE scope=$1 AND idempotency_key=$2",
      [scope, key],
    );
    if (prior.rows[0]) {
      const op = prior.rows[0];
      const repository = repositoryConfig();
      if (
        op.checkpoint.repository !== repository.key ||
        op.checkpoint.baseBranch !== repository.branch
      )
        throw new PipelineError("repository_configuration_changed", 409);
      if (
        op.payload.baseCommit !== input.baseCommit ||
        (kind === "merge" && op.payload.headSha !== input.headSha)
      )
        throw new PipelineError("idempotency_conflict", 409);
      await launchOperation(op.id);
      return json({ operation: operationView(op) }, 202);
    }
    await enforceRateLimits([
      { key: `map-action:${user.id}`, max: 30, seconds: 3600 },
    ]);
    const payload =
      kind === "rollback"
        ? await rollbackInput(id, input.baseCommit)
        : { updateId: id, ...input };
    if (kind === "merge") {
      const review = await reviewMapUpdate(id);
      if (!review.canMerge)
        throw new PipelineError(review.blockedReason || "merge_blocked", 409);
      if (
        review.headSha !== input.headSha ||
        review.baseCommit !== input.baseCommit
      )
        throw new PipelineError("pr_identity_changed", 409);
    }
    const op = await acceptOperation({
      kind,
      scope,
      key,
      actorId: user.id,
      payload,
      authorize: async () => {
        await requireAdmin(request);
      },
    });
    await launchOperation(op.id);
    return json({ operation: operationView(op) }, 202);
  } catch (error) {
    return failure(error);
  }
}
export const postMerge = (request: Request, context: Context) =>
  submit(request, context, "merge");
export const postRollback = (request: Request, context: Context) =>
  submit(request, context, "rollback");
