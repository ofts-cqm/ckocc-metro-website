import {
  leaseOperation,
  finishOperation,
  getOperation,
  checkpoint,
} from "./store";
import {
  PipelineError,
  providerBackoff,
  safeErrorCode,
  statusOf,
} from "./errors";
import { processDiscussion } from "./discussion";
import { processCloseIssue } from "./close-issue";
import { processUpdate } from "./update";
import { processMaintenanceSync } from "./maintenance";
import { processMerge, requireOperationAdmin } from "./map-actions";
import {
  synchronizePublication,
  synchronizePullRequests,
} from "@/server/maps/publication";
import { invalidateIssues } from "@/server/github/issues";
import { AppError } from "@/server/http";
import { getActiveUser } from "@/server/auth/authorize";
import { repositoryConfig } from "@/server/github/client";

export async function executeOperation(
  id: string,
): Promise<{ retry: boolean; delay: number }> {
  const leased = await leaseOperation(id);
  if (!leased) return { retry: false, delay: 0 };
  const { op, token } = leased;
  try {
    const repository = repositoryConfig();
    if (
      op.checkpoint.repository !== repository.key ||
      op.checkpoint.baseBranch !== repository.branch
    )
      throw new PipelineError("repository_configuration_changed", 409);
    if (op.actor_id) {
      const actor = await getActiveUser(op.actor_id);
      if (op.kind === "sync" && actor.role !== "admin")
        throw new PipelineError("forbidden", 403);
    }
    if (op.kind === "merge" || op.kind === "rollback")
      await requireOperationAdmin(op);
    if (op.kind === "close-issue" && !op.actor_id)
      throw new PipelineError("unauthorized", 401);
    if (op.kind === "request" || op.kind === "comment") {
      const result = await processDiscussion(op, token);
      await finishOperation(id, token, "succeeded", result);
    } else if (op.kind === "close-issue") {
      const result = await processCloseIssue(op, token);
      await finishOperation(id, token, "succeeded", result);
    } else if (op.kind === "merge") {
      const result = await processMerge(op, token);
      await invalidateIssues();
      await synchronizePullRequests();
      await synchronizePublication();
      await finishOperation(id, token, "succeeded", {
        ...result,
        publicationPending: false,
      });
    } else if (op.kind === "refresh-update") {
      const result = await processMaintenanceSync(op, token);
      await finishOperation(id, token, "succeeded", result);
    } else if (op.kind === "update" || op.kind === "rollback") {
      const result = await processUpdate(op, token);
      await finishOperation(id, token, "awaiting_review", result);
    } else {
      await invalidateIssues();
      await synchronizePullRequests();
      const result =
        op.payload.publication === false ? {} : await synchronizePublication();
      await finishOperation(id, token, "succeeded", result);
    }
    return { retry: false, delay: 0 };
  } catch (error) {
    const fresh = await getOperation(id);
    const code = error instanceof AppError ? error.code : safeErrorCode(error);
    if (code === "stale_base_revision") {
      await finishOperation(id, token, "needs_reconciliation", {}, code);
      return { retry: false, delay: 0 };
    }
    const hasWriteIntent =
      (op.kind === "request" || op.kind === "comment") &&
      fresh.checkpoint.writeIntent &&
      !fresh.checkpoint.discussionResult;
    const hasPrIntent =
      (op.kind === "update" || op.kind === "rollback") &&
      fresh.checkpoint.prIntent &&
      !fresh.checkpoint.prResult;
    const hasRefreshIntent =
      op.kind === "refresh-update" && fresh.checkpoint.refreshIntent;
    const hasMergeIntent =
      op.kind === "merge" &&
      fresh.checkpoint.mergeIntent &&
      !fresh.checkpoint.mergeResult;
    if (
      code === "outcome_unknown" ||
      hasWriteIntent ||
      hasPrIntent ||
      hasRefreshIntent ||
      hasMergeIntent
    ) {
      // A timeout can hide a successful external write. One bounded authoritative lookup
      // runs immediately; subsequent administrator retries repeat only this recovery path.
      if (code !== "outcome_unknown") {
        try {
          const recovered =
            op.kind === "refresh-update"
              ? await processMaintenanceSync(fresh, token)
              : op.kind === "merge"
                ? await processMerge(fresh, token)
                : op.kind === "update" || op.kind === "rollback"
                  ? await processUpdate(fresh, token)
                  : await processDiscussion(fresh, token);
          if (op.kind === "merge") {
            await synchronizePullRequests();
            await synchronizePublication();
          }
          await finishOperation(
            id,
            token,
            op.kind === "update" || op.kind === "rollback"
              ? "awaiting_review"
              : "succeeded",
            recovered,
          );
          return { retry: false, delay: 0 };
        } catch {
          /* No second content-creation POST after an inconclusive lookup. */
        }
      }
      await finishOperation(
        id,
        token,
        "outcome_unknown",
        {},
        "outcome_unknown",
      );
      return { retry: false, delay: 0 };
    }
    const delay = providerBackoff(error);
    const status = statusOf(error);
    const retry =
      op.attempts < 5 &&
      !(error instanceof PipelineError && error.status < 500) &&
      !(error instanceof AppError && error.status < 500) &&
      status !== 401 &&
      status !== 403 &&
      status !== 422;
    await checkpoint(id, token, { lastSafeFailure: code, autoRetry: retry });
    await finishOperation(
      id,
      token,
      "failed",
      op.kind === "merge"
        ? ((fresh.checkpoint.mergeResult as
            Record<string, unknown> | undefined) ?? {})
        : {},
      code,
      delay,
    );
    return { retry, delay };
  }
}
