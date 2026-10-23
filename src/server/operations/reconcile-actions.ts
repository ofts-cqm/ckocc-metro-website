import { query, transaction } from "@/server/db";
import { repositoryConfig } from "@/server/github/client";
import { recordedPullRequest } from "./map-actions";
import type { Operation } from "./store";

const actionKinds = ["merge", "close-update", "edit-update", "refresh-update"];
type StoredOperation = Operation & { lease_until: Date | null };

function canSupersede(op: StoredOperation) {
  return (
    actionKinds.includes(op.kind) &&
    ["failed", "needs_reconciliation"].includes(op.status) &&
    !(op.lease_until && new Date(op.lease_until).getTime() > Date.now()) &&
    // Any external-write intent/result requires action-specific recovery. In
    // particular, a merged PR does not prove image publication succeeded.
    !Object.keys(op.checkpoint).some((key) => /Intent$|Result$/.test(key)) &&
    !op.result.mergeCommitSha &&
    op.result.publicationPending !== true
  );
}

/** Retire obsolete, pre-write PR actions using live evidence; never retry a write. */
export async function reconcileTerminalActions() {
  const repository = repositoryConfig();
  const pending = await query<StoredOperation>(
    `SELECT a.* FROM metro_operations a JOIN metro_operations s ON s.id::text=a.payload->>'updateId'
     WHERE a.kind=ANY($1::text[]) AND a.status IN ('failed','needs_reconciliation')
     AND a.checkpoint->>'repository'=$2 AND a.checkpoint->>'baseBranch'=$3
     AND s.kind IN ('update','rollback') AND s.result ? 'prNumber'
     AND s.status IN ('closed_unmerged','merged','published')
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(a.checkpoint) AS k(key) WHERE key ~ '(Intent|Result)$')
     AND NOT(a.result ? 'mergeCommitSha') AND a.result->>'publicationPending' IS DISTINCT FROM 'true'
     AND s.checkpoint->>'repository'=$2 AND s.checkpoint->>'baseBranch'=$3
     AND (a.lease_until IS NULL OR a.lease_until<now())
     AND (s.lease_until IS NULL OR s.lease_until<now())
     ORDER BY a.updated_at LIMIT 50`,
    [actionKinds, repository.key, repository.branch],
  );
  let reconciled = 0;
  for (const action of pending.rows) {
    if (!canSupersede(action)) continue;
    let observation: Awaited<ReturnType<typeof recordedPullRequest>>;
    try {
      observation = await recordedPullRequest(String(action.payload.updateId));
    } catch {
      // Unavailable or conflicting identity evidence keeps the alert visible.
      continue;
    }
    const { op: observed, pr } = observation;
    if (pr.state !== "closed") continue;
    const recorded = await transaction(async (client) => {
      // Source-first locking matches action acceptance and maintenance recovery.
      const source = (
        await client.query<StoredOperation>(
          "SELECT * FROM metro_operations WHERE id=$1 FOR UPDATE SKIP LOCKED",
          [observed.id],
        )
      ).rows[0];
      if (!source) return false;
      const current = (
        await client.query<StoredOperation>(
          "SELECT * FROM metro_operations WHERE id=$1 FOR UPDATE SKIP LOCKED",
          [action.id],
        )
      ).rows[0];
      if (
        !source ||
        !current ||
        !canSupersede(current) ||
        current.kind !== action.kind ||
        current.payload.updateId !== source.id ||
        current.checkpoint.repository !== repository.key ||
        current.checkpoint.baseBranch !== repository.branch ||
        source.kind !== observed.kind ||
        source.result.prNumber !== pr.number ||
        !["closed_unmerged", "merged", "published"].includes(source.status) ||
        source.checkpoint.repository !== repository.key ||
        source.checkpoint.baseBranch !== repository.branch ||
        (source.lease_until &&
          new Date(source.lease_until).getTime() > Date.now())
      )
        return false;
      await client.query(
        `UPDATE metro_operations SET status='superseded',error_code=NULL,
         checkpoint=checkpoint||$2::jsonb,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1`,
        [
          current.id,
          JSON.stringify({
            autoRetry: false,
            reconciliation: {
              reason: pr.merged ? "pr_merged" : "pr_closed_unmerged",
              previousStatus: current.status,
              previousError: current.error_code,
              prNumber: pr.number,
              observedAt: new Date().toISOString(),
            },
          }),
        ],
      );
      await client.query(
        "UPDATE metro_outbox SET state='done',updated_at=now() WHERE operation_id=$1",
        [current.id],
      );
      await client.query(
        "INSERT INTO metro_pipeline_audit(action,operation_id) VALUES('supersede-terminal-pr-action',$1)",
        [current.id],
      );
      return true;
    });
    if (recorded) reconciled++;
  }
  return reconciled;
}
