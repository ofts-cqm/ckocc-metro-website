import { start } from "workflow/api";
import { operationWorkflow } from "@/workflows/operation";
import { query } from "@/server/db";

export async function launchOperation(id: string) {
  const claimed = await query(
    `UPDATE metro_outbox SET state='launching',attempts=attempts+1,updated_at=now()
    WHERE operation_id=$1 AND (state='pending' OR (state='launching' AND updated_at<now()-interval '5 minutes')) RETURNING operation_id`,
    [id],
  );
  if (!claimed.rowCount) return;
  try {
    const run = await start(operationWorkflow, [id]);
    await query(
      "UPDATE metro_outbox SET state='started',run_id=$2,updated_at=now() WHERE operation_id=$1 AND state='launching'",
      [id, run.runId],
    );
  } catch {
    // An accepted response remains durable even when the workflow service is temporarily unavailable.
    await query(
      `UPDATE metro_outbox SET state='pending',next_attempt_at=now()+interval '1 minute',updated_at=now()
      WHERE operation_id=$1 AND state='launching'`,
      [id],
    );
  }
}

export async function repairOutbox() {
  // Crashed workflow steps become eligible after the operation lease has safely expired.
  await query(`UPDATE metro_outbox b SET state='pending',updated_at=now() FROM metro_operations o
    WHERE b.operation_id=o.id AND b.state IN ('started','launching') AND b.updated_at<now()-interval '20 minutes'
    AND (o.lease_until IS NULL OR o.lease_until<now()) AND o.status IN ('accepted','validating','creating_pr')`);
  // A workflow may disappear after persisting a retry but before its durable sleep resumes.
  // Keep permanent failures and unknown writes manual; due transient retries remain bounded.
  await query(`UPDATE metro_outbox b SET state='pending',next_attempt_at=o.next_attempt_at,updated_at=now() FROM metro_operations o
    WHERE b.operation_id=o.id AND (b.state='failed' OR (b.state IN ('started','launching') AND b.updated_at<now()-interval '20 minutes'))
    AND o.status='failed' AND o.checkpoint->>'autoRetry'='true' AND o.attempts<5 AND o.next_attempt_at<=now()
    AND (o.lease_until IS NULL OR o.lease_until<now())`);
  const pending = await query<{ operation_id: string }>(
    `SELECT operation_id FROM metro_outbox WHERE state='pending' AND next_attempt_at<=now() ORDER BY updated_at LIMIT 25`,
  );
  for (const row of pending.rows) await launchOperation(row.operation_id);
  return pending.rowCount || 0;
}
