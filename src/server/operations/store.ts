import { randomUUID, timingSafeEqual } from "node:crypto";
import type { OperationView, OperationStatus } from "@/lib/contracts";
import { query, transaction } from "@/server/db";
import { sha256 } from "@/server/maps/validate";
import { PipelineError } from "./errors";
import { repositoryConfig } from "@/server/github/client";

export interface Operation {
  id: string;
  kind: "request" | "comment" | "update" | "sync";
  scope: string;
  idempotency_key: string;
  request_digest: string;
  actor_id: string | null;
  receipt_digest: string | null;
  status: OperationStatus;
  payload: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  result: Record<string, unknown>;
  attempts: number;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
  next_attempt_at: Date;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function sameDigest(a: string, b: string) {
  return (
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}

export async function acceptOperation(input: {
  kind: Operation["kind"];
  scope: string;
  key: string;
  actorId?: string;
  receiptToken?: string;
  payload: Record<string, unknown>;
  authorize: () => Promise<void>;
}) {
  const digest = sha256(canonical(input.payload));
  const repository = repositoryConfig();
  const checkExisting = (op: Operation) => {
    if (op.request_digest !== digest)
      throw new PipelineError("idempotency_conflict", 409);
    if (
      op.actor_id !== (input.actorId ?? null) ||
      (op.receipt_digest &&
        !sameDigest(op.receipt_digest, sha256(input.receiptToken || "")))
    )
      throw new PipelineError("operation_not_found", 404);
    return op;
  };
  const prior = await query<Operation>(
    "SELECT * FROM metro_operations WHERE scope=$1 AND idempotency_key=$2",
    [input.scope, input.key],
  );
  if (prior.rows[0]) return checkExisting(prior.rows[0]);
  // Never hold a pooled transaction client while authorization takes another client.
  // Turnstile verification uses this stable key as its provider idempotency key.
  await input.authorize();
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `operation:${input.scope}:${input.key}`,
    ]);
    const existing = await client.query<Operation>(
      "SELECT * FROM metro_operations WHERE scope=$1 AND idempotency_key=$2",
      [input.scope, input.key],
    );
    if (existing.rows[0]) {
      return checkExisting(existing.rows[0]);
    }
    if (input.kind === "update") {
      const session = await client.query<{ status: string; owner_id: string }>(
        "SELECT status,owner_id FROM metro_edit_sessions WHERE id=$1 AND expires_at>now() FOR UPDATE",
        [input.payload.editSessionId],
      );
      if (
        !session.rows[0] ||
        session.rows[0].status !== "draft" ||
        session.rows[0].owner_id !== input.actorId
      )
        throw new PipelineError("edit_session_expired", 409);
      const uploads = await client.query<{ id: string; kind: string }>(
        `SELECT id,kind FROM metro_uploads WHERE id=ANY($1::uuid[]) AND edit_session_id=$2
        AND owner_id=$3 AND status='ready' AND expires_at>now() FOR UPDATE`,
        [
          [input.payload.jsonUploadId, input.payload.pngUploadId],
          input.payload.editSessionId,
          input.actorId,
        ],
      );
      if (
        uploads.rows.length !== 2 ||
        !uploads.rows.some(
          (u) => u.id === input.payload.jsonUploadId && u.kind === "json",
        ) ||
        !uploads.rows.some(
          (u) => u.id === input.payload.pngUploadId && u.kind === "png",
        )
      )
        throw new PipelineError("invalid_upload");
    }
    const result = await client.query<Operation>(
      `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,actor_id,receipt_digest,status,payload,checkpoint)
      VALUES($1,$2,$3,$4,$5,$6,$7,'accepted',$8,$9) RETURNING *`,
      [
        randomUUID(),
        input.kind,
        input.scope,
        input.key,
        digest,
        input.actorId ?? null,
        input.receiptToken ? sha256(input.receiptToken) : null,
        JSON.stringify(input.payload),
        JSON.stringify({
          repository: repository.key,
          baseBranch: repository.branch,
        }),
      ],
    );
    await client.query("INSERT INTO metro_outbox(operation_id) VALUES($1)", [
      result.rows[0].id,
    ]);
    if (input.kind === "update")
      await client.query(
        "UPDATE metro_edit_sessions SET status='submitted' WHERE id=$1",
        [input.payload.editSessionId],
      );
    return result.rows[0];
  });
}

export async function getOperation(id: string) {
  const result = await query<Operation>(
    "SELECT * FROM metro_operations WHERE id=$1",
    [id],
  );
  if (!result.rows[0]) throw new PipelineError("operation_not_found", 404);
  return result.rows[0];
}
export function operationView(op: Operation): OperationView {
  return {
    id: op.id,
    kind: op.kind,
    status: op.status,
    createdAt: new Date(op.created_at).toISOString(),
    updatedAt: new Date(op.updated_at).toISOString(),
    result: op.result,
    errorCode: op.error_code,
    retryAt:
      op.status === "failed" &&
      op.checkpoint.autoRetry === true &&
      op.attempts < 5
        ? new Date(op.next_attempt_at).toISOString()
        : null,
  };
}

export const terminalStates = [
  "succeeded",
  "awaiting_review",
  "needs_reconciliation",
  "merged",
  "published",
  "closed_unmerged",
];
export async function leaseOperation(
  id: string,
): Promise<{ op: Operation; token: string } | null> {
  const token = randomUUID();
  const result = await query<Operation>(
    `UPDATE metro_operations SET lease_token=$2,lease_until=now()+interval '15 minutes',attempts=attempts+1,updated_at=now()
    WHERE id=$1 AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) AND NOT(status=ANY($3::text[])) RETURNING *`,
    [id, token, terminalStates],
  );
  return result.rows[0] ? { op: result.rows[0], token } : null;
}
export async function checkpoint(
  id: string,
  token: string,
  patch: Record<string, unknown>,
  status?: OperationStatus,
) {
  const result = await query(
    `UPDATE metro_operations SET checkpoint=checkpoint||$3::jsonb,status=COALESCE($4,status),updated_at=now(),lease_until=now()+interval '15 minutes'
    WHERE id=$1 AND lease_token=$2 AND lease_until>now() RETURNING id`,
    [id, token, JSON.stringify(patch), status ?? null],
  );
  if (!result.rowCount) throw new PipelineError("operation_lease_lost", 409);
}
export async function finishOperation(
  id: string,
  token: string,
  status: OperationStatus,
  result: Record<string, unknown> = {},
  error?: string,
  delay = 60,
) {
  await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE metro_operations SET status=$3,result=result||$4::jsonb,error_code=$5,lease_until=NULL,lease_token=NULL,
      next_attempt_at=now()+$6*interval '1 second',updated_at=now() WHERE id=$1 AND lease_token=$2 RETURNING id`,
      [id, token, status, JSON.stringify(result), error ?? null, delay],
    );
    if (!updated.rowCount) throw new PipelineError("operation_lease_lost", 409);
    await client.query(
      `UPDATE metro_outbox SET state=$2,updated_at=now(),next_attempt_at=now()+$3*interval '1 second' WHERE operation_id=$1`,
      [id, status === "failed" ? "failed" : "done", delay],
    );
    await client.query(
      "UPDATE metro_webhook_deliveries SET state=$2 WHERE operation_id=$1",
      [
        id,
        status === "succeeded" || status === "published" ? "done" : "pending",
      ],
    );
  });
}

export async function retryOperation(id: string, actorId: string) {
  return transaction(async (client) => {
    const found = await client.query<Operation>(
      "SELECT * FROM metro_operations WHERE id=$1 FOR UPDATE",
      [id],
    );
    const op = found.rows[0];
    if (!op) throw new PipelineError("operation_not_found", 404);
    if (!["failed", "outcome_unknown", "accepted"].includes(op.status))
      throw new PipelineError("operation_not_retryable", 409);
    // Preserve every checkpoint, particularly write intent. Unknown writes only reconcile.
    await client.query(
      "UPDATE metro_operations SET next_attempt_at=now(),error_code=NULL WHERE id=$1",
      [id],
    );
    await client.query(
      `INSERT INTO metro_outbox(operation_id) VALUES($1) ON CONFLICT(operation_id) DO UPDATE SET state='pending',next_attempt_at=now(),updated_at=now()`,
      [id],
    );
    await client.query(
      "INSERT INTO metro_pipeline_audit(actor_id,action,operation_id) VALUES($1,'retry',$2)",
      [actorId, id],
    );
    return op;
  });
}
