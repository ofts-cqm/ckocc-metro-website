import { query } from "@/server/db";
import { getActiveUser } from "@/server/auth/authorize";
import {
  currentHead,
  MAP_PATHS,
  readFileAt,
  repositoryConfig,
} from "@/server/github/client";
import { headManifest } from "@/server/maps/sessions";
import { sha256 } from "@/server/maps/validate";
import {
  acceptOperation,
  checkpoint,
  getOperation,
  type Operation,
} from "./store";
import { PipelineError, statusOf } from "./errors";
import { readValidatedMap, websitePullRequest } from "./map-actions";

/** Durable and deduplicated across webhook, review, and repair requests. */
export async function queueMaintenanceSync(
  updateId: string,
  headSha: string,
  baseCommit: string,
) {
  const source = await getOperation(updateId);
  if (!source.actor_id) throw new PipelineError("unauthorized", 401);
  const operation = await acceptOperation({
    kind: "refresh-update",
    scope: `refresh-update:${updateId}`,
    key: sha256(`${headSha}\n${baseCommit}`),
    actorId: source.actor_id,
    payload: {
      updateId,
      headSha,
      baseCommit,
      baseMapRevision: source.payload.baseMapRevision,
    },
    authorize: async () => {
      await getActiveUser(source.actor_id!);
    },
  });
  const { launchOperation } = await import("./outbox");
  await launchOperation(operation.id);
  return operation;
}

/** Called by normal webhook/read reconciliation; GitHub remains the merge gate. */
export async function queuePendingMaintenance() {
  const { key, branch } = repositoryConfig();
  const current = await headManifest();
  const pending = await query<Operation>(
    `SELECT * FROM metro_operations WHERE kind IN ('update','rollback') AND status='awaiting_review'
     AND checkpoint->>'repository'=$1 AND checkpoint->>'baseBranch'=$2
     AND payload->>'baseMapRevision'=$3
     AND checkpoint->>'maintenanceBaseCommit' IS DISTINCT FROM $4
     AND checkpoint->>'prParentCommit' IS DISTINCT FROM $4
     ORDER BY updated_at LIMIT 25`,
    [key, branch, current.manifest.map_revision, current.commit],
  );
  for (const source of pending.rows) {
    if (!source.actor_id || typeof source.checkpoint.commitSha !== "string")
      continue;
    // Disabled authors must not block reconciliation of every other pending PR.
    try {
      await getActiveUser(source.actor_id);
    } catch (error) {
      if (statusOf(error) === 401) continue;
      throw error;
    }
    await queueMaintenanceSync(
      source.id,
      source.checkpoint.commitSha,
      current.commit,
    );
  }
}

export async function processMaintenanceSync(
  operation: Operation,
  token: string,
) {
  if (!operation.actor_id) throw new PipelineError("unauthorized", 401);
  await getActiveUser(operation.actor_id);
  const input = operation.payload;
  const expectedHead = String(input.headSha),
    baseCommit = String(input.baseCommit);
  let plannedHead = operation.checkpoint.refreshCommit as string | undefined;
  const {
    op: source,
    pr,
    client,
  } = await websitePullRequest(String(input.updateId), plannedHead);
  const { owner, repo, branch, key } = repositoryConfig();
  if (
    source.actor_id !== operation.actor_id ||
    source.checkpoint.repository !== key ||
    source.checkpoint.baseBranch !== branch ||
    input.baseMapRevision !== source.payload.baseMapRevision
  )
    throw new PipelineError("pr_identity_changed", 409);

  const record = async (head: string) => {
    // Updating the ref and losing its response must still reconcile this pointer.
    const updated = await query(
      `UPDATE metro_operations SET checkpoint=checkpoint||$3::jsonb,updated_at=now()
       WHERE id=$1 AND status IN ('awaiting_review','merged','published','closed_unmerged') AND checkpoint->>'commitSha'=$2 RETURNING id`,
      [
        source.id,
        expectedHead,
        JSON.stringify({
          originalCommitSha:
            source.checkpoint.originalCommitSha ?? expectedHead,
          commitSha: head,
          maintenancePreviousHead: expectedHead,
          maintenanceBaseCommit: baseCommit,
          maintenanceOperationId: operation.id,
        }),
      ],
    );
    if (!updated.rowCount && source.checkpoint.commitSha !== head)
      throw new PipelineError("outcome_unknown", 409);
    return { updateId: source.id, headSha: head, baseCommit };
  };

  const observeHead = async () =>
    (
      await client.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${pr.head.ref}`,
      })
    ).data.object.sha;
  if (plannedHead && (await observeHead()) === plannedHead)
    return record(plannedHead);
  // Once an update-ref call is uncertain, only observe; never repeat the write.
  if (operation.checkpoint.refreshIntent)
    throw new PipelineError("outcome_unknown", 409);
  if (pr.merged || pr.state !== "open" || source.status !== "awaiting_review")
    return { updateId: source.id, skipped: true };
  if (
    pr.head.sha !== expectedHead ||
    source.checkpoint.commitSha !== expectedHead
  )
    throw new PipelineError("pr_identity_changed", 409);
  if ((await currentHead()) !== baseCommit)
    return { updateId: source.id, skipped: true };

  const [approved, candidate, originalBase] = await Promise.all([
    readValidatedMap(baseCommit),
    readValidatedMap(expectedHead),
    readValidatedMap(String(source.payload.baseCommit)),
  ]);
  if (
    approved.manifest.map_revision !== input.baseMapRevision ||
    originalBase.manifest.map_revision !== input.baseMapRevision ||
    !approved.json.equals(originalBase.json) ||
    !approved.png.equals(originalBase.png)
  )
    throw new PipelineError("stale_base_revision", 409);
  if (
    candidate.manifest.operation_id !== source.id ||
    candidate.manifest.map_revision !== source.checkpoint.mapRevision ||
    candidate.manifest.base_map_revision !== input.baseMapRevision ||
    candidate.manifest.base_commit_sha !== source.payload.baseCommit
  )
    throw new PipelineError("pr_identity_changed", 409);
  const files = await client.paginate(client.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });
  if (
    files.some(
      (file) =>
        !Object.values(MAP_PATHS).includes(
          file.filename as typeof MAP_PATHS.json,
        ) || !["added", "modified"].includes(file.status),
    )
  )
    throw new PipelineError("pr_identity_changed", 409);
  const comparison = await client.rest.repos.compareCommits({
    owner,
    repo,
    base: baseCommit,
    head: expectedHead,
  });
  if (comparison.data.behind_by === 0) return record(expectedHead);

  if (!plannedHead) {
    const base = await client.rest.git.getCommit({
      owner,
      repo,
      commit_sha: baseCommit,
    });
    const blobs = await Promise.all(
      [
        candidate.json,
        candidate.png,
        // Preserve the manifest bytes too, not a reserialized approximation.
        await readFileAt(expectedHead, MAP_PATHS.manifest, 64 * 1024),
      ].map((bytes) =>
        client.rest.git.createBlob({
          owner,
          repo,
          content: bytes.toString("base64"),
          encoding: "base64",
        }),
      ),
    );
    const tree = await client.rest.git.createTree({
      owner,
      repo,
      base_tree: base.data.tree.sha,
      tree: Object.values(MAP_PATHS).map((path, index) => ({
        path,
        mode: "100644",
        type: "blob",
        sha: blobs[index].data.sha,
      })),
    });
    const author = {
      name: "CKOCC Metro Bot",
      email: "metro-bot@users.noreply.github.com",
      date: new Date(operation.created_at).toISOString(),
    };
    const commit = await client.rest.git.createCommit({
      owner,
      repo,
      tree: tree.data.sha,
      parents: [expectedHead, baseCommit],
      author,
      committer: author,
      message: `Catch up map PR after maintenance ${operation.id}`,
    });
    plannedHead = commit.data.sha;
    await checkpoint(operation.id, token, { refreshCommit: plannedHead });
  }
  // Recheck both refs, account, and map revision immediately before the write.
  const fresh = await websitePullRequest(source.id);
  if (
    fresh.pr.state !== "open" ||
    fresh.pr.merged ||
    fresh.pr.head.sha !== expectedHead
  )
    throw new PipelineError("pr_identity_changed", 409);
  if ((await currentHead()) !== baseCommit)
    return { updateId: source.id, skipped: true };
  await getActiveUser(operation.actor_id);
  await checkpoint(operation.id, token, { refreshIntent: true });
  try {
    await client.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${pr.head.ref}`,
      sha: plannedHead,
      force: false,
    });
  } catch (error) {
    const observedHead = await observeHead();
    if (observedHead === plannedHead) return record(plannedHead);
    if (
      observedHead === expectedHead &&
      [403, 409, 422].includes(statusOf(error) ?? 0)
    ) {
      await checkpoint(operation.id, token, { refreshIntent: false });
      throw new PipelineError("maintenance_sync_failed", 409);
    }
    throw new PipelineError("outcome_unknown", 409);
  }
  if ((await observeHead()) !== plannedHead)
    throw new PipelineError("outcome_unknown", 409);
  return record(plannedHead);
}
