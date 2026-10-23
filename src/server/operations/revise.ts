import { randomUUID } from "node:crypto";
import type { SessionUser } from "@/lib/contracts";
import { transaction } from "@/server/db";
import { sessionView, type EditSessionRecord } from "@/server/maps/sessions";
import { canReviseUpdate, type Operation } from "./store";
import { PipelineError } from "./errors";
import {
  assertInactiveUpdate,
  assertUpdateIdle,
  assertUpdateRepository,
} from "./manage-updates";

export async function reviseUpdate(id: string, user: SessionUser) {
  const recovered = await transaction(async (client) => {
    const found = await client.query<Operation & { lease_until: Date | null }>(
      "SELECT * FROM metro_operations WHERE id=$1 FOR UPDATE",
      [id],
    );
    const op = found.rows[0];
    if (!op || (op.actor_id !== user.id && user.role !== "admin"))
      throw new PipelineError("operation_not_found", 404);
    assertUpdateRepository(op);
    if (
      !canReviseUpdate(op) ||
      (op.lease_until && new Date(op.lease_until).getTime() > Date.now())
    )
      throw new PipelineError("operation_not_retryable", 409);
    await assertUpdateIdle(client, op);
    if (op.status === "closed_unmerged") await assertInactiveUpdate(op);
    let session: EditSessionRecord;
    if (op.checkpoint.revisedEditSessionId) {
      const existing = await client.query<EditSessionRecord>(
        "SELECT * FROM metro_edit_sessions WHERE id=$1 AND owner_id=$2 AND status='draft' AND expires_at>now()",
        [op.checkpoint.revisedEditSessionId, user.id],
      );
      if (!existing.rows[0])
        throw new PipelineError("edit_session_expired", 409);
      session = existing.rows[0];
    } else {
      // Keep the submitted operation and assets intact. The replacement retains
      // the recorded base, never silently rebasing the user's exported document.
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
      session = created.rows[0];
      await client.query(
        "UPDATE metro_operations SET checkpoint=checkpoint||$2::jsonb,updated_at=now() WHERE id=$1",
        [id, JSON.stringify({ revisedEditSessionId: session.id })],
      );
      await client.query(
        "UPDATE metro_outbox SET state='done',updated_at=now() WHERE operation_id=$1",
        [id],
      );
      await client.query(
        "INSERT INTO metro_pipeline_audit(actor_id,action,operation_id) VALUES($1,'revise',$2)",
        [user.id, id],
      );
    }
    return { session, payload: op.payload };
  });
  return {
    editSession: await sessionView(recovered.session),
    summary: recovered.payload.summary,
    details: recovered.payload.details,
    issueNumbers: recovered.payload.issueNumbers,
  };
}
