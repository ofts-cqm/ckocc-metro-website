import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { SessionUser } from "@/lib/contracts";
import { query, transaction } from "@/server/db";
import { github, repositoryConfig } from "@/server/github/client";
import { sessionView, type EditSessionRecord } from "@/server/maps/sessions";
import { canDeleteUpdate, checkpoint, type Operation } from "./store";
import {
  requireOperationAdmin,
  recordedPullRequest,
  inspectRecordedPullRequest,
  inspectWebsitePullRequest,
} from "./map-actions";
import { PipelineError } from "./errors";

export async function assertUpdateIdle(
  client: PoolClient,
  op: Operation & { lease_until?: Date | null },
) {
  if (op.lease_until && new Date(op.lease_until).getTime() > Date.now())
    throw new PipelineError("update_busy", 409);
  const pending = await client.query(
    `SELECT id FROM metro_operations WHERE payload->>'updateId'=$1
     AND kind IN ('merge','close-update','edit-update','refresh-update')
     AND (status IN ('accepted','validating','creating_pr','outcome_unknown')
       OR (status='failed' AND checkpoint->>'autoRetry'='true') OR lease_until>now()) LIMIT 1`,
    [op.id],
  );
  if (pending.rows.length) throw new PipelineError("update_busy", 409);
}

export function assertUpdateRepository(op: Operation) {
  const repo = repositoryConfig();
  if (
    op.checkpoint.repository !== repo.key ||
    op.checkpoint.baseBranch !== repo.branch
  )
    throw new PipelineError("repository_configuration_changed", 409);
}

/** A stored closed status alone is insufficient: a PR can have been reopened. */
export async function assertInactiveUpdate(op: Operation) {
  assertUpdateRepository(op);
  if (op.result.prNumber) {
    const { pr } = await inspectRecordedPullRequest(op);
    if (pr.state === "open")
      throw new PipelineError("update_has_active_pr", 409);
    return;
  }
  if (op.checkpoint.prIntent || op.checkpoint.prResult)
    throw new PipelineError("outcome_unknown", 409);
  if (op.checkpoint.branchIntent || op.checkpoint.commitSha) {
    const client = await github();
    const { owner, repo } = repositoryConfig();
    const prs = await client.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:metro-update/${op.id}`,
      state: "all",
      per_page: 100,
    });
    // An unrecorded PR needs reconciliation, even if already closed.
    if (prs.data.length) throw new PipelineError("outcome_unknown", 409);
  }
}

export async function deleteUpdate(id: string, user: SessionUser) {
  return transaction(async (client) => {
    const found = await client.query<Operation>(
      "SELECT * FROM metro_operations WHERE id=$1 FOR UPDATE",
      [id],
    );
    const op = found.rows[0];
    if (
      !op ||
      !["update", "rollback"].includes(op.kind) ||
      (op.actor_id !== user.id && user.role !== "admin")
    )
      throw new PipelineError("operation_not_found", 404);
    assertUpdateRepository(op);
    if (op.checkpoint.deletedAt) return;
    if (!canDeleteUpdate(op))
      throw new PipelineError("update_not_deletable", 409);
    await assertUpdateIdle(client, op);
    await assertInactiveUpdate(op);
    await client.query(
      "UPDATE metro_operations SET checkpoint=checkpoint||$2::jsonb,updated_at=now() WHERE id=$1",
      [
        id,
        JSON.stringify({
          deletedAt: new Date().toISOString(),
          deletedBy: user.id,
        }),
      ],
    );
    await client.query(
      "UPDATE metro_outbox SET state='done',updated_at=now() WHERE operation_id=$1",
      [id],
    );
    await client.query(
      "INSERT INTO metro_pipeline_audit(actor_id,action,operation_id) VALUES($1,'delete-update',$2)",
      [user.id, id],
    );
  });
}

/** Active PR edits use a new editor-owned upload session but retain PR identity. */
export async function beginUpdateEdit(id: string, user: SessionUser) {
  if (user.role !== "admin") throw new PipelineError("forbidden", 403);
  const recovered = await transaction(async (client) => {
    const found = await client.query<Operation>(
      "SELECT * FROM metro_operations WHERE id=$1 FOR UPDATE",
      [id],
    );
    const op = found.rows[0];
    if (
      !op ||
      op.checkpoint.deletedAt ||
      !["update", "rollback"].includes(op.kind)
    )
      throw new PipelineError("update_not_found", 404);
    await assertUpdateIdle(client, op);
    const { pr } = await inspectWebsitePullRequest(op);
    if (pr.merged || pr.state !== "open")
      throw new PipelineError("pr_closed", 409);
    if (op.checkpoint.amendEditSessionId) {
      const existing = await client.query<EditSessionRecord>(
        "SELECT * FROM metro_edit_sessions WHERE id=$1 AND status='draft' AND expires_at>now()",
        [op.checkpoint.amendEditSessionId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].owner_id !== user.id)
          throw new PipelineError("update_busy", 409);
        if (op.checkpoint.amendHeadSha === pr.head.sha)
          return { session: existing.rows[0], payload: op.payload };
        // A maintenance update can advance the PR while its editor is offline.
        // Retire the stale session before issuing a draft pinned to the new head.
        await client.query(
          "UPDATE metro_edit_sessions SET status='expired' WHERE id=$1",
          [existing.rows[0].id],
        );
      }
    }
    const created = await client.query<EditSessionRecord>(
      `INSERT INTO metro_edit_sessions(id,owner_id,base_commit,base_revision,expires_at)
       VALUES($1,$2,$3,$4,now()+interval '7 days') RETURNING *`,
      [
        randomUUID(),
        user.id,
        op.payload.baseCommit,
        op.payload.baseMapRevision,
      ],
    );
    const session = created.rows[0];
    await client.query(
      "UPDATE metro_operations SET checkpoint=checkpoint||$2::jsonb,updated_at=now() WHERE id=$1",
      [
        id,
        JSON.stringify({
          amendEditSessionId: session.id,
          amendHeadSha: pr.head.sha,
        }),
      ],
    );
    await client.query(
      "INSERT INTO metro_pipeline_audit(actor_id,action,operation_id) VALUES($1,'begin-update-edit',$2)",
      [user.id, id],
    );
    return { session, payload: op.payload };
  });
  return {
    editSession: await sessionView(recovered.session),
    summary: recovered.payload.summary,
    details: recovered.payload.details,
    issueNumbers: recovered.payload.issueNumbers,
  };
}

export async function processCloseUpdate(op: Operation, token: string) {
  await requireOperationAdmin(op);
  const {
    op: source,
    pr,
    client,
  } = await recordedPullRequest(String(op.payload.updateId));
  if (source.checkpoint.deletedAt)
    throw new PipelineError("update_not_found", 404);
  if (pr.merged) throw new PipelineError("pr_already_merged", 409);
  const record = async () => {
    const result = { prNumber: pr.number, prUrl: pr.html_url, state: "closed" };
    await checkpoint(op.id, token, { closeResult: result });
    await query(
      "UPDATE metro_operations SET status='closed_unmerged',updated_at=now() WHERE id=$1 AND status NOT IN ('merged','published')",
      [op.payload.updateId],
    );
    return result;
  };
  if (pr.state === "closed") return record();
  if (op.checkpoint.closeIntent)
    throw new PipelineError("outcome_unknown", 409);
  await requireOperationAdmin(op);
  await checkpoint(op.id, token, { closeIntent: true });
  const { owner, repo } = repositoryConfig();
  await client.rest.pulls.update({
    owner,
    repo,
    pull_number: pr.number,
    state: "closed",
  });
  const fresh = await recordedPullRequest(String(op.payload.updateId));
  if (fresh.pr.merged) throw new PipelineError("pr_already_merged", 409);
  if (fresh.pr.state !== "closed")
    throw new PipelineError("outcome_unknown", 409);
  return record();
}
