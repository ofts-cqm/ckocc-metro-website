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
    if (op.kind === "close-issue" && !op.actor_id)
      throw new PipelineError("unauthorized", 401);
    if (op.kind === "request" || op.kind === "comment") {
      const result = await processDiscussion(op, token);
      await finishOperation(id, token, "succeeded", result);
    } else if (op.kind === "close-issue") {
      const result = await processCloseIssue(op, token);
      await finishOperation(id, token, "succeeded", result);
    } else if (op.kind === "update") {
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
      op.kind === "update" &&
      fresh.checkpoint.prIntent &&
      !fresh.checkpoint.prResult;
    if (code === "outcome_unknown" || hasWriteIntent || hasPrIntent) {
      // A timeout can hide a successful external write. One bounded authoritative lookup
      // runs immediately; subsequent administrator retries repeat only this recovery path.
      if (code !== "outcome_unknown") {
        try {
          const recovered =
            op.kind === "update"
              ? await processUpdate(fresh, token)
              : await processDiscussion(fresh, token);
          await finishOperation(
            id,
            token,
            op.kind === "update" ? "awaiting_review" : "succeeded",
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
    await finishOperation(id, token, "failed", {}, code, delay);
    return { retry, delay };
  }
}
