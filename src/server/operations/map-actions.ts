import type { MapUpdateReview, MapCheckState } from "@/lib/contracts";
import { query } from "@/server/db";
import { getActiveUser } from "@/server/auth/authorize";
import {
  github,
  repositoryConfig,
  expectedBotLogin,
  currentHead,
  readFileAt,
  MAP_PATHS,
} from "@/server/github/client";
import { headManifest, resolveMapBase } from "@/server/maps/sessions";
import {
  MAP_LIMITS,
  parseManifest,
  validatePair,
} from "@/server/maps/validate";
import { checkpoint, getOperation, type Operation } from "./store";
import { PipelineError } from "./errors";

export async function requireOperationAdmin(op: Operation) {
  if (!op.actor_id) throw new PipelineError("unauthorized", 401);
  const user = await getActiveUser(op.actor_id);
  if (user.role !== "admin") throw new PipelineError("forbidden", 403);
  return user;
}

export async function websitePullRequest(id: string) {
  const op = await getOperation(id);
  const { owner, repo, branch, key } = repositoryConfig();
  if (
    !["update", "rollback"].includes(op.kind) ||
    op.checkpoint.repository !== key ||
    op.checkpoint.baseBranch !== branch ||
    !Number.isSafeInteger(op.result.prNumber)
  )
    throw new PipelineError("update_not_found", 404);
  const client = await github();
  const pr = (
    await client.rest.pulls.get({
      owner,
      repo,
      pull_number: Number(op.result.prNumber),
    })
  ).data;
  if (
    pr.base.repo.full_name.toLowerCase() !== key.toLowerCase() ||
    pr.base.ref !== branch ||
    pr.head.repo?.full_name.toLowerCase() !== key.toLowerCase() ||
    pr.head.ref !== `metro-update/${op.id}` ||
    pr.user?.login !== expectedBotLogin() ||
    !pr.body?.includes(`<!-- metro-operation:${op.id} -->`) ||
    pr.head.sha !== op.checkpoint.commitSha
  )
    throw new PipelineError("pr_identity_changed", 409);
  return { op, pr, client };
}

export async function readValidatedMap(commit: string) {
  const [json, png, bytes] = await Promise.all([
    readFileAt(commit, MAP_PATHS.json, MAP_LIMITS.json),
    readFileAt(commit, MAP_PATHS.png, MAP_LIMITS.png),
    readFileAt(commit, MAP_PATHS.manifest, 64 * 1024),
  ]);
  const manifest = parseManifest(bytes);
  await validatePair(json, png, manifest);
  return { json, png, manifest };
}

/** Readiness is advisory; the worker repeats it immediately before its write. */
export async function reviewMapUpdate(id: string) {
  const { op, pr, client } = await websitePullRequest(id);
  const current = await headManifest();
  const { owner, repo, branch } = repositoryConfig();
  const review: MapUpdateReview = {
    validation: {
      state: "pending",
      checkedAt: new Date().toISOString(),
      runs: [],
    },
    headSha: pr.head.sha,
    baseCommit: current.commit,
    currentRevision: current.manifest.map_revision,
    mapRevision: String(op.checkpoint.mapRevision),
    restoreRevision: String(op.payload.baseMapRevision),
    prNumber: pr.number,
    prUrl: pr.html_url,
    merged: pr.merged,
    canMerge: false,
    canRollback: false,
    blockedReason: null as string | null,
  };
  if (pr.merged) {
    const base = await resolveMapBase(String(op.payload.baseCommit));
    const restored = await readValidatedMap(base.commit);
    if (restored.manifest.map_revision !== op.payload.baseMapRevision)
      throw new PipelineError("historical_map_mismatch", 409);
    review.canRollback =
      restored.manifest.map_revision !== current.manifest.map_revision;
    review.blockedReason = review.canRollback ? null : "unchanged_map";
    return review;
  }
  // Read checks even when another rule blocks merging, so the review can show
  // their actual state. Only trust GitHub Actions on the current PR commits.
  try {
    const results = await Promise.all(
      [
        ...new Set(
          [pr.head.sha, pr.merge_commit_sha].filter((s): s is string => !!s),
        ),
      ].map((ref) =>
        client.paginate(client.rest.checks.listForRef, {
          owner,
          repo,
          ref,
          check_name: "validate-map",
          filter: "latest",
          per_page: 100,
        }),
      ),
    );
    const trusted = results
      .flat()
      .filter(
        (check) =>
          check.name === "validate-map" && check.app?.slug === "github-actions",
      );
    review.validation.runs = trusted.map((check) => {
      const state: MapCheckState =
        check.status !== "completed"
          ? check.status === "in_progress"
            ? "running"
            : "pending"
          : check.conclusion === "success"
            ? "success"
            : check.conclusion === "cancelled"
              ? "cancelled"
              : check.conclusion === "skipped"
                ? "skipped"
                : "failure";
      return {
        id: check.id,
        state,
        title: check.output?.title?.slice(0, 300) || null,
        url: check.html_url || null,
      };
    });
    const states = review.validation.runs.map((run) => run.state);
    review.validation.state =
      (["failure", "cancelled", "skipped", "running", "pending"] as const).find(
        (state) => states.includes(state),
      ) ?? (states.length ? "success" : "pending");
  } catch {
    // A provider outage must never leave a previous passing result actionable.
    review.validation.state = "unavailable";
  }
  review.validation.checkedAt = new Date().toISOString();
  if (pr.state !== "open") review.blockedReason = "pr_closed";
  else if (process.env.WEBSITE_MERGES_ENABLED !== "true")
    review.blockedReason = "merge_not_configured";
  else if (pr.draft) review.blockedReason = "pr_draft";
  else if (op.payload.baseMapRevision !== current.manifest.map_revision)
    review.blockedReason = "stale_base_revision";
  else if (
    pr.base.sha !== current.commit ||
    pr.mergeable !== true ||
    !["clean", "blocked"].includes(pr.mergeable_state)
  )
    review.blockedReason = "merge_blocked";
  if (review.blockedReason) return review;
  // Restrict-updates rulesets can report "blocked" even for an app allowed to
  // merge through PRs. Validate the candidate/checks below; GitHub's merge API
  // remains authoritative for all branch rules and the caller's permissions.
  const [files, candidate, repoInfo, protectedBranch] = await Promise.all([
    client.paginate(client.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    }),
    readValidatedMap(pr.head.sha),
    client.rest.repos.get({ owner, repo }),
    client.rest.repos.getBranch({ owner, repo, branch }),
  ]);
  if (!repoInfo.data.allow_merge_commit || !protectedBranch.data.protected) {
    review.blockedReason = "merge_not_configured";
    return review;
  }
  if (
    files.length === 0 ||
    files.some(
      (file) =>
        !Object.values(MAP_PATHS).includes(
          file.filename as typeof MAP_PATHS.json,
        ) || !["added", "modified"].includes(file.status),
    ) ||
    candidate.manifest.operation_id !== op.id ||
    candidate.manifest.map_revision !== op.checkpoint.mapRevision ||
    candidate.manifest.base_commit_sha !== op.payload.baseCommit ||
    candidate.manifest.base_map_revision !== current.manifest.map_revision
  )
    throw new PipelineError("pr_identity_changed", 409);
  review.blockedReason =
    review.validation.state === "success" ? null : "map_checks_pending";
  review.canMerge = review.validation.state === "success";
  return review;
}

export async function rollbackInput(id: string, expectedBase: string) {
  const review = await reviewMapUpdate(id);
  if (!review.merged || !review.canRollback)
    throw new PipelineError(review.blockedReason || "pr_not_merged", 409);
  if (review.baseCommit !== expectedBase)
    throw new PipelineError("stale_base_revision", 409);
  const { op } = await websitePullRequest(id);
  return {
    updateId: id,
    restoreCommit: String(op.payload.baseCommit),
    restoreRevision: review.restoreRevision,
    baseCommit: review.baseCommit,
    baseMapRevision: review.currentRevision,
    summary: `Restore map before PR ${review.prNumber}`,
    details: `Restores the complete map before PR ${review.prNumber}. Later map changes are removed. Previously resolved requests remain closed.`,
    issueNumbers: [] as number[],
  };
}

export async function processMerge(op: Operation, token: string) {
  await requireOperationAdmin(op);
  const id = String(op.payload.updateId);
  const { pr, client } = await websitePullRequest(id);
  const { owner, repo } = repositoryConfig();
  const recordMerge = async (mergeCommitSha: string | null) => {
    const result = {
      prNumber: pr.number,
      prUrl: pr.html_url,
      mergeCommitSha,
      publicationPending: true,
    };
    await checkpoint(op.id, token, { mergeResult: result });
    await query(
      `UPDATE metro_operations SET status='merged',result=result||$2::jsonb,updated_at=now()
       WHERE id=$1 AND status='awaiting_review'`,
      [id, JSON.stringify({ ...result, mergedAt: new Date().toISOString() })],
    );
    return result;
  };
  if (pr.head.sha !== op.payload.headSha)
    throw new PipelineError("pr_identity_changed", 409);
  if (pr.merged) {
    return recordMerge(pr.merge_commit_sha);
  }
  if (op.checkpoint.mergeIntent)
    throw new PipelineError("outcome_unknown", 409);
  const review = await reviewMapUpdate(id);
  if (!review.canMerge)
    throw new PipelineError(review.blockedReason || "merge_blocked", 409);
  if (
    review.baseCommit !== op.payload.baseCommit ||
    (await currentHead()) !== review.baseCommit
  )
    throw new PipelineError("stale_base_revision", 409);
  await requireOperationAdmin(op);
  await checkpoint(op.id, token, { mergeIntent: true }, "validating");
  try {
    const merged = await client.rest.pulls.merge({
      owner,
      repo,
      pull_number: pr.number,
      sha: String(op.payload.headSha),
      merge_method: "merge",
    });
    if (!merged.data.merged) {
      await checkpoint(op.id, token, { mergeIntent: false });
      throw new PipelineError("merge_blocked", 409);
    }
    return await recordMerge(merged.data.sha);
  } catch (error) {
    // Reconcile even explicit provider failures: a transport can hide a completed merge.
    const fresh = await websitePullRequest(id);
    if (fresh.pr.merged) {
      return recordMerge(fresh.pr.merge_commit_sha);
    }
    if (error instanceof PipelineError) throw error;
    const status = (error as { status?: number }).status;
    if (status && [403, 405, 409, 422].includes(status)) {
      await checkpoint(op.id, token, { mergeIntent: false });
      throw new PipelineError("merge_blocked", 409);
    }
    throw new PipelineError("outcome_unknown", 409);
  }
}
