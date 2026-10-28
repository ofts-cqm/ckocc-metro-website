import type { Pool } from "pg";
import type { Operation } from "../../src/server/operations/store";

export type Snapshot = Operation & {
  version: string;
  lease_until: Date | null;
};
export type PullEvidence = {
  number: number;
  state: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  repository: string;
  creator: string;
};
type Context = {
  repository: string;
  branch: string;
  bot: string;
  readPull: (number: number) => Promise<PullEvidence>;
};
export type Decision = {
  reason: string;
  status?: Operation["status"];
  result?: Record<string, unknown>;
  source?: Snapshot;
  prNumber?: number;
};
const attention = ["failed", "needs_reconciliation", "outcome_unknown"];
const updates = ["update", "rollback"];
const actions = ["merge", "close-update", "edit-update", "refresh-update"];
const terminal = ["merged", "published", "closed_unmerged"];
/** Detects an active worker lease before the operator considers a row. */
const live = (op: Snapshot) =>
  !!op.lease_until && new Date(op.lease_until).getTime() > Date.now();
/** Detects evidence that an operation may already have made an external write. */
const writes = (op: Snapshot) =>
  Object.keys(op.checkpoint).some((key) => /Intent$|Result$/.test(key)) ||
  !!op.result.mergeCommitSha ||
  op.result.publicationPending === true;
/** Limits reconciliation to the repository and branch selected by the operator. */
const matches = (op: Snapshot, ctx: Context) =>
  op.checkpoint.repository === ctx.repository &&
  op.checkpoint.baseBranch === ctx.branch;

/** Proposes a safe state change from stored checkpoints and GitHub PR evidence.
 * The reconciliation scan invokes it for each operation; uncertain writes stay unresolved. */
export async function inspectOperation(
  op: Snapshot,
  ctx: Context,
  loadSource: (id: string) => Promise<Snapshot | undefined>,
): Promise<Decision> {
  // Reject busy, mismatched, or write-uncertain rows before provider inspection.
  if (!matches(op, ctx)) return { reason: "different_repository_or_branch" };
  if (live(op)) return { reason: "live_lease" };
  if (op.status === "outcome_unknown")
    return { reason: "action_specific_recovery_required" };
  if (
    updates.includes(op.kind) &&
    attention.includes(op.status) &&
    op.checkpoint.deletedAt
  ) {
    if (
      writes(op) ||
      op.checkpoint.commitSha ||
      op.result.prNumber ||
      op.checkpoint.autoRetry === true
    )
      return { reason: "deleted_update_requires_review" };
    return { status: "superseded", reason: "deleted_before_external_write" };
  }
  let source: Snapshot | undefined;
  if (
    actions.includes(op.kind) &&
    ["failed", "needs_reconciliation"].includes(op.status)
  ) {
    if (writes(op)) return { reason: "action_specific_recovery_required" };
    if (
      typeof op.payload.updateId !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(op.payload.updateId)
    )
      return { reason: "missing_source" };
    source = await loadSource(op.payload.updateId);
    if (
      !source ||
      !updates.includes(source.kind) ||
      !matches(source, ctx) ||
      live(source)
    )
      return { reason: "source_unavailable_or_busy" };
    if (!["awaiting_review", ...terminal].includes(source.status))
      return { reason: "source_requires_review" };
  } else if (!(updates.includes(op.kind) && op.status === "awaiting_review")) {
    return {
      reason: attention.includes(op.status)
        ? "action_specific_recovery_required"
        : "unchanged",
    };
  }
  const target = source ?? op;
  // Verify the PR identity and closure state before proposing a transition.
  const number = target.result.prNumber;
  if (!Number.isSafeInteger(number) || Number(number) <= 0)
    return { reason: "missing_pr" };
  let pr: PullEvidence;
  try {
    pr = await ctx.readPull(Number(number));
  } catch {
    return { reason: "provider_unavailable" };
  }
  if (
    !ctx.bot ||
    pr.number !== number ||
    pr.repository.toLowerCase() !== ctx.repository.toLowerCase() ||
    pr.creator !== ctx.bot
  )
    return { reason: "pr_identity_mismatch" };
  if (pr.state !== "closed") return { reason: "pr_open" };
  if (source)
    return {
      status: "superseded",
      source,
      prNumber: pr.number,
      reason: pr.merged ? "pr_merged" : "pr_closed_unmerged",
    };
  // A closed PR cannot prove publication. Never downgrade a published update or
  // clear its publicationPending flag based on PR state alone.
  if (pr.merged && !pr.mergeCommitSha)
    return { reason: "missing_merge_commit" };
  return {
    status: pr.merged ? "merged" : "closed_unmerged",
    reason: pr.merged ? "pr_merged" : "pr_closed_unmerged",
    prNumber: pr.number,
    result: {
      mergedAt: pr.mergedAt,
      mergeCommitSha: pr.mergeCommitSha,
      publicationPending: pr.merged,
    },
  };
}

/** Loads an operation with its row version for the reconciliation scan. */
export async function loadOperation(pool: Pool, id: string) {
  return (
    await pool.query<Snapshot>(
      "SELECT *,xmin::text AS version FROM metro_operations WHERE id=$1",
      [id],
    )
  ).rows[0];
}

/** Applies an approved reconciliation decision with version and lease checks.
 * The CLI invokes it only with --apply after the read-only evidence pass. */
export async function applyDecision(
  pool: Pool,
  op: Snapshot,
  decision: Decision,
) {
  if (!decision.status) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    for (const expected of [
      ...(decision.source ? [decision.source] : []),
      op,
    ]) {
      const current = (
        await client.query<Snapshot>(
          "SELECT *,xmin::text AS version FROM metro_operations WHERE id=$1 FOR UPDATE SKIP LOCKED",
          [expected.id],
        )
      ).rows[0];
      if (!current || current.version !== expected.version || live(current)) {
        await client.query("ROLLBACK");
        return false;
      }
    }
    await client.query(
      `UPDATE metro_operations SET status=$2,error_code=NULL,
       checkpoint=checkpoint||$3::jsonb,result=result||$4::jsonb,
       lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1`,
      [
        op.id,
        decision.status,
        JSON.stringify({
          autoRetry: false,
          reconciliation: {
            reason: decision.reason,
            previousStatus: op.status,
            previousError: op.error_code,
            prNumber: decision.prNumber,
            observedAt: new Date().toISOString(),
            method: "manual-script",
          },
        }),
        JSON.stringify(decision.result ?? {}),
      ],
    );
    await client.query(
      "UPDATE metro_outbox SET state='done',updated_at=now() WHERE operation_id=$1",
      [op.id],
    );
    await client.query(
      "INSERT INTO metro_pipeline_audit(action,operation_id) VALUES('manual-reconcile-operation',$1)",
      [op.id],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Scans operations, reports proposals, and optionally applies safe decisions.
 * The operator CLI calls this for preview and explicit apply workflows. */
export async function reconcileOperations(
  pool: Pool,
  ctx: Context,
  apply: boolean,
  report: (entry: Record<string, unknown>) => void = console.log,
) {
  // Page through all rows and inspect each with current provider evidence.
  const summary = {
    scanned: 0,
    proposed: 0,
    applied: 0,
    raced: 0,
    unresolved: 0,
  };
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const page = await pool.query<Snapshot>(
      "SELECT *,xmin::text AS version FROM metro_operations WHERE id>$1 ORDER BY id LIMIT 100",
      [cursor],
    );
    if (!page.rows.length) break;
    for (const op of page.rows) {
      summary.scanned++;
      const decision = await inspectOperation(op, ctx, (id) =>
        loadOperation(pool, id),
      );
      let applied = false;
      if (decision.status) {
        summary.proposed++;
        if (apply) {
          applied = await applyDecision(pool, op, decision);
          if (applied) summary.applied++;
          else summary.raced++;
        }
      }
      const missingEvidence = [
        "provider_unavailable",
        "pr_identity_mismatch",
        "missing_pr",
        "missing_merge_commit",
      ].includes(decision.reason);
      if (
        (attention.includes(op.status) || missingEvidence) &&
        !decision.status
      )
        summary.unresolved++;
      if (decision.status || attention.includes(op.status) || missingEvidence)
        report({
          id: op.id,
          kind: op.kind,
          status: op.status,
          proposedStatus: decision.status,
          reason: decision.reason,
          applied,
        });
      cursor = op.id;
    }
  }
  return summary;
}
